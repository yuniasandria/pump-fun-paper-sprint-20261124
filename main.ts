// Pump.fun Paper Sprint: buy every new coin once, early, then exit on a plan.
//
// Entry: a coin becomes a candidate on the batch that carries its CreateEvent.
// It is decided exactly once, on the first batch from then on where the size
// cap (hello.caps.max_order_bps_of_real_reserve of its real SOL reserve) lets
// it buy at least MIN_BUY. On that batch it buys min(STAKE, the cap) when the
// position cap, the per-batch order cap and free cash all allow it; otherwise
// the coin is skipped for good. One buy per coin, never a re-buy, never a buy
// on a curve that already completed. Coins are taken in event order.
//
// Exit: every held position is re-priced every batch from its curve's latest
// virtual reserves. Value = tokens * virtual_quote_reserves /
// virtual_token_reserves, compared against the cost the account reports for
// the tokens still held. Three exits, whichever fires first, each selling the
// whole position: take-profit at 2x cost, stop-loss at 0.5x cost, and a time
// stop about 2 hours after the buy fill landed (the dev window runs about
// 16,800 slots an hour, so ~33,600 slots). The house closes a completed curve
// and flattens what is left at the end of the data, so exits only race the
// market, never the harness.
//
// The buy-and-hold baseline buys the same way and never sells; the edge here
// is the exits: they bank the runners at 2x and cut the dead coins at half
// instead of riding them to the flatten.
//
// Determinism: every decision comes from the harness feed alone (hello,
// batch, orders, slot, fills, marks). No clock, no environment, no
// Math.random, so two runs produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type Curve,
  type SellInput,
} from './vendor/makefun-bot.ts';

/** SOL staked on each new coin. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
/** Smallest buy worth taking: also the guardrail's round-trip minimum. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Wide open, so a fill is never refused for the price moving in the latency. */
const MAX_SLIPPAGE_BPS = 10_000;
/** Take-profit: sell when value * TAKE_PROFIT_DEN >= TAKE_PROFIT_NUM * cost. */
const TAKE_PROFIT_NUM = 2n;
const TAKE_PROFIT_DEN = 1n;
/** Stop-loss: sell when the position is worth half what it cost. */
const STOP_LOSS_DIV = 2n;
/** Time stop in slots: about 2 hours at ~16,800 slots an hour. */
const TIME_STOP_SLOTS = 33_600;

/** Coins created and not yet decided. */
const candidates = new Set<string>();
/** Coins already decided (bought or skipped): never bought twice. */
const decided = new Set<string>();
/** Mint -> slot of its buy fill, for the time stop. */
const entrySlot = new Map<string, number>();
/** Mints with a sell still in flight. */
const sellPending = new Set<string>();
/** Mint -> last priced reserves + value: a position is re-priced only when its curve or the holding moved. */
const valueCache = new Map<string, { vt: bigint; vq: bigint; tokens: bigint; cost: bigint; value: bigint }>();
/** Base + priority fee per order, cached on first use: constant for the run. */
let cachedTxFee: bigint | null = null;

/** Current value of a holding in lamports, from the curve's virtual reserves. */
function positionValue(curve: Curve, tokenAmount: bigint): bigint {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (tokenAmount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

/**
 * Value of a holding, re-priced only when its curve's reserves or the
 * holding itself moved. The value is a pure function of (reserves, tokens),
 * so the cached value decides exactly like a fresh pricing; the time stop
 * is still checked from the slot on every batch.
 */
function cachedValue(mint: string, curve: Curve, tokenAmount: bigint, cost: bigint): bigint {
  const c = valueCache.get(mint);
  if (
    c !== undefined &&
    c.vt === curve.virtual_token_reserves &&
    c.vq === curve.virtual_quote_reserves &&
    c.tokens === tokenAmount &&
    c.cost === cost
  ) {
    return c.value;
  }
  const value = positionValue(curve, tokenAmount);
  valueCache.set(mint, {
    vt: curve.virtual_token_reserves,
    vq: curve.virtual_quote_reserves,
    tokens: tokenAmount,
    cost,
    value,
  });
  return value;
}

await runBot({
  onBatch(state: BotState, batch) {
    // Learn from the fills that resolved since the last batch: a buy fill
    // starts a position's clock, a sell fill frees its mint for a fresh exit.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        entrySlot.set(fill.mint, fill.slot);
      } else if (fill.side === 'sell') {
        sellPending.delete(fill.mint);
      }
    }

    const { caps } = state.hello;
    const txFee = (cachedTxFee ??= state.txFeeLamports());
    const orders: Array<BuyInput | SellInput> = [];

    // Exits first: bank the runners, cut the losers, drop the stale ones.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = cachedValue(mint, curve, holding.token_amount, holding.cost_lamports);
      const cost = holding.cost_lamports;
      const enteredAt = entrySlot.get(mint);
      const agedOut = enteredAt !== undefined && state.slot - enteredAt >= TIME_STOP_SLOTS;
      const tookProfit = value * TAKE_PROFIT_DEN >= TAKE_PROFIT_NUM * cost;
      const stoppedOut = value * STOP_LOSS_DIV <= cost;
      if (!tookProfit && !stoppedOut && !agedOut) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      sellPending.add(mint);
    }

    // Entries, in the batch's event order, with what the exits left over.
    // Free cash without the SDK's per-batch call: cash minus the tx fee and
    // buy amounts of pending orders — the same formula it computes.
    let free = state.cash;
    for (const po of state.pending.values()) {
      free -= txFee;
      if (po.order.side === 'buy') free -= BigInt(po.order.quote_lamports);
    }
    // Committed positions without the SDK's per-batch Set: the bot never
    // holds two pending buys on one mint (a candidate is decided once and a
    // pending mint is skipped), so counting pending buys not already held
    // equals the distinct-mint count exactly.
    let committed = state.positions.size;
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy' && !state.positions.has(po.order.mint)) committed++;
    }
    let slots = caps.max_open_positions - committed;
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!decided.has(event.mint)) candidates.add(event.mint);
      }
      if (!candidates.has(event.mint)) continue;
      const curve = state.curves.get(event.mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(event.mint);
        decided.add(event.mint);
        continue;
      }
      // The size cap is real_quote_reserves * 100 / 10000, so it reaches
      // MIN_BUY (0.01 SOL) exactly when the real reserve reaches 1 SOL:
      // skip the BigInt multiply/divide for every coin still below it.
      if (curve.real_quote_reserves < LAMPORTS_PER_SOL) continue;
      const cap = state.maxBuyLamports(event.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      candidates.delete(event.mint);
      decided.add(event.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0 || free < amount + txFee) {
        continue;
      }
      orders.push({
        side: 'buy',
        mint: event.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      slots -= 1;
    }
    return orders;
  },
});
