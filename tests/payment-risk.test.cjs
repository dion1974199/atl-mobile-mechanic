const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, mocks) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in mocks)) throw Error(`Unexpected dependency ${name}`);
    return mocks[name];
  }, process: { env: { STRIPE_SECRET_KEY: "sk_test_offline_fixture", STRIPE_WEBHOOK_SECRET: "whsec_offline_fixture" } } });
  return exports;
}
function fixture({ singles = [{ id: 'bill', stripe_charge_id: null }], parts = [], charge = {}, current = {}, rpcError = null } = {}) {
  const calls = [];
  const admin = {
    from: table => ({ select: () => ({ eq: async () => ({ data: table === 'service_payments' ? singles : parts, error: null }) }) }),
    rpc: async (name, args) => { calls.push({ name, args }); return { data: true, error: rpcError }; }
  };
  const stripe = {
    charges: { retrieve: async () => ({ id: 'ch_1', payment_intent: 'pi_1', livemode: false, ...charge }) },
    refunds: { retrieve: async () => ({ id: 're_1', charge: 'ch_1', payment_intent: 'pi_1', status: 'succeeded', ...current }) },
    disputes: { retrieve: async () => ({ id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', status: 'won', ...current }) }
  };
  const event = { type: 'refund.created', livemode: false, data: { object: { id: 're_1', charge: 'ch_1', payment_intent: 'pi_1', status: 'pending' } } };
  const { handlePaymentRiskEvent: run } = load('lib/stripe/handle-payment-risk-event.ts', { stripe: class {}, '@/lib/supabase/admin': {} });
  return { run: () => run(event, stripe, admin), event, calls };
}
test('single refund uses current status and verified ownership RPC', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.calls[0].name, 'record_verified_payment_payout_hold');
  assert.equal(f.calls[0].args.p_stripe_status, 'succeeded');
  assert.equal(f.calls[0].args.p_payment_intent_id, 'pi_1');
});
test('split refund resolves parent even before charge is recorded', async () => {
  const f = fixture({ singles: [], parts: [{ id: 'part', service_payment_id: 'parent', stripe_charge_id: null }] });
  await f.run(); assert.equal(f.calls[0].args.p_payment_id, 'parent');
});
for (const [name, options] of [
  ['missing match', { singles: [] }],
  ['ambiguous cross-mode match', { parts: [{ service_payment_id: 'bill', stripe_charge_id: null }] }],
  ['stored charge mismatch', { singles: [{ id: 'bill', stripe_charge_id: 'ch_other' }] }],
  ['event intent mismatch', { charge: { payment_intent: 'pi_other' } }],
  ['mode mismatch', { charge: { livemode: true } }],
  ['current object mismatch', { current: { charge: 'ch_other' } }],
  ['database refusal', { rpcError: { message: 'ownership changed' } }]
]) test(name, async () => { const f = fixture(options); await assert.rejects(f.run); if (!options.rpcError) assert.equal(f.calls.length, 0); });
test('connected account event rejected', async () => { const f = fixture(); f.event.account = 'acct_other'; await assert.rejects(f.run); assert.equal(f.calls.length, 0); });
test('charge supplies missing event intent', async () => { const f = fixture(); f.event.data.object.payment_intent = null; await f.run(); assert.equal(f.calls.length, 1); });
test('closed dispute still holds payout', async () => {
  const f = fixture(); f.event.type = 'charge.dispute.closed'; f.event.data.object.id = 'dp_1';
  await f.run(); assert.equal(f.calls[0].args.p_reason, 'dispute'); assert.equal(f.calls[0].args.p_stripe_status, 'won');
});
test('failed refunds still hold payout', async () => { const f = fixture({ current: { status: 'failed' } }); await f.run(); assert.equal(f.calls.length, 1); });
for (const mode of ['single', 'split']) {
  test(`${mode}: hold wins attempt race; no Stripe transfer`, async () => {
    let transfers = 0;
      let attemptCalls = 0;
    const admin = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { payment_status: 'paid', transfer_status: 'processing', stripe_transfer_id: null, single_transfer_attempted_at: null, payout_hold_reason: null }, error: null }) }) }) }),
      rpc: async () => { attemptCalls++; return { data: false, error: null }; }
    };
    const mocks = {
      stripe: class {}, '@/lib/supabase/admin': { createAdminClient: () => admin },
      './verify-transfer-funding': { verifyTransferFunding: async () => {} },
      '@/lib/stripe/find-single-transfer': { findSingleTransfer: async () => null },
      '@/lib/stripe/find-split-transfer': { findSplitTransfer: async () => null }
    };
    const functions = load(`lib/stripe/create-${mode}-transfer.ts`, mocks);
    const run = functions[mode === 'single' ? 'createSingleTransfer' : 'createSplitTransfer'];
    await assert.rejects(() => run({ transfers: { create: async () => { transfers++; } } }, 'bill', 'request', 'acct_1', 850, 'group', true));
    assert.equal(transfers, 0);
      assert.equal(attemptCalls, 1, 'Transfer attempt safeguard must be reached');
  });
}
test('signed risk webhook routed; invalid signature rejected; handler failure retried', async () => {
  const Stripe = require('stripe');
  const secret = 'whsec_offline_fixture';
  let risks = 0, fail = false;
  const mocks = {
    stripe: Stripe,
    'next/server': { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    '@/lib/supabase/admin': {},
    '@/lib/stripe/handle-payment-risk-event': { handlePaymentRiskEvent: async () => { risks++; if (fail) throw Error('retry'); } },
  };
  for (const name of ['handle-split-payment', 'handle-split-payment-failure', 'verify-single-payment', 'create-single-transfer', 'reconcile-single-transfer']) mocks['@/lib/stripe/' + name] = {};
  const { POST } = load('app/api/stripe/webhook/route.ts', mocks);
  const payload = JSON.stringify({ id: 'evt_offline', object: 'event', type: 'refund.created', data: { object: { id: 're_1' } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const request = sig => ({ text: async () => payload, headers: { get: () => sig } });
  assert.equal((await POST(request(signature))).status, 200); assert.equal(risks, 1);
  assert.equal((await POST(request('invalid'))).status, 400); assert.equal(risks, 1);
  fail = true; assert.equal((await POST(request(signature))).status, 500);
});
for (const [name, changes, refunds] of [
  ['clean charge', {}, []], ['partial refund', { amount_refunded: 1 }, []],
  ['dispute', { disputed: true }, []], ['pending refund', {}, [{ status: 'pending' }]],
  ['failed refund', {}, [{ status: 'failed' }]]
]) test(`funding verification: ${name}`, async () => {
  const { verifySinglePayment } = load('lib/stripe/verify-single-payment.ts', { stripe: {} });
  const stripe = {
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', latest_charge: 'ch_1', status: 'succeeded', amount_received: 1000, currency: 'usd', metadata: { service_payment_id: 'bill', service_request_id: 'request' }, transfer_group: 'group' }) },
    charges: { retrieve: async () => ({ payment_intent: 'pi_1', amount: 1000, currency: 'usd', status: 'succeeded', paid: true, refunded: false, amount_refunded: 0, disputed: false, ...changes }) },
    refunds: { list: async () => ({ data: refunds, has_more: false }) }
  };
  const run = () => verifySinglePayment(stripe, 'pi_1', 'bill', 'request', 1000, 'group');
  if (name === 'clean charge') assert.equal(await run(), 'ch_1'); else await assert.rejects(run);
});
test('split transfer funding verifies both cards and rejects changed charge', async () => {
  const seen = [];
  let wrong = false;
  const admin = { from: table => ({ select: () => ({ eq: () => table === 'service_payments'
    ? { single: async () => ({ data: { request_id: 'request', stripe_payment_intent_id: null, payout_hold_reason: null } }) }
    : Promise.resolve({ data: [1,2].map(n => ({ id: `part${n}`, stripe_payment_intent_id: `pi_${n}`, stripe_charge_id: `ch_${n}`, amount_cents: 500 })) }) }) }) };
  const { verifyTransferFunding } = load('lib/stripe/verify-transfer-funding.ts', {
    stripe: {}, '@/lib/supabase/admin': { createAdminClient: () => admin },
    './verify-single-payment': { verifySinglePayment: async (_stripe, id) => { seen.push(id); return wrong ? 'ch_wrong' : id.replace('pi_', 'ch_'); } }
  });
  await verifyTransferFunding({}, 'bill'); assert.deepEqual(seen, ['pi_1','pi_2']);
  wrong = true; await assert.rejects(() => verifyTransferFunding({}, 'bill'));
});
for (const mode of ['single', 'split']) {
  test(`${mode}: partial and full reversals cannot reconcile as an intact payout`, () => {
    const functions = load(`lib/stripe/find-${mode}-transfer.ts`, { stripe: {} });
    const verify = functions[mode === 'single' ? 'verifySingleTransfer' : 'verifySplitTransfer'];
    const transfer = { amount: 850, currency: 'usd', destination: 'acct_1', transfer_group: 'group',
      metadata: { service_payment_id: 'bill', service_request_id: 'request', payment_mode: mode },
      reversed: false, amount_reversed: 0 };
    const run = () => verify(transfer, 'bill', 'request', 'acct_1', 850, 'group');
    assert.doesNotThrow(run);
    transfer.amount_reversed = 100; assert.throws(run);
    transfer.amount_reversed = 850; transfer.reversed = true; assert.throws(run);
    transfer.amount_reversed = 0; transfer.reversed = false;
    transfer.metadata.service_payment_id = 'other'; assert.throws(run);
  });
}
