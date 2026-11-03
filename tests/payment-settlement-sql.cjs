const { PGlite } = require(process.env.PGLITE_MODULE || '/tmp/atl-risk-test/node_modules/@electric-sql/pglite');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const db = new PGlite();

  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql
        AS $$ SELECT 'service_role'::text $$;

      CREATE TABLE service_payments (
        id uuid PRIMARY KEY,
        request_id uuid,
        customer_id uuid,
        provider_id uuid,
        stripe_payment_intent_id text,
        stripe_charge_id text,
        payment_status text DEFAULT 'pending',
        authorized_amount numeric,
        marketplace_fee_percent numeric,
        marketplace_fee_amount numeric,
        provider_amount numeric,
        currency text DEFAULT 'usd',
        paid_at timestamptz,
        payment_error text,
        updated_at timestamptz
      );

      CREATE TABLE service_requests (
        id uuid PRIMARY KEY,
        customer_id uuid,
        provider_id uuid,
        status text,
        customer_confirmed_at timestamptz
      );

      CREATE TABLE service_payment_parts (
        id uuid PRIMARY KEY,
        service_payment_id uuid,
        payment_status text,
        stripe_payment_intent_id text,
        stripe_charge_id text,
        amount_cents bigint,
        currency text DEFAULT 'usd'
      );
    `);

    const migration = fs.readFileSync(
      'supabase/migrations/20261030120000_separate_payment_and_provider_transfer.sql',
      'utf8'
    );

    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.record_verified_single_payment(');
    const end = migration.indexOf('GRANT EXECUTE ON FUNCTION public.record_verified_single_payment(uuid,text,text)', start);
    assert.ok(start >= 0 && end > start, 'Settlement function must exist');

    const grantEnd = migration.indexOf(';', end) + 1;
    await db.exec(migration.slice(start, grantEnd));


    // Load the actual split-payment settlement function.
    const splitStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.record_verified_split_payment('
    );
    const splitGrant = migration.indexOf(
      'GRANT EXECUTE ON FUNCTION public.record_verified_split_payment(uuid)',
      splitStart
    );
    assert.ok(splitStart >= 0 && splitGrant > splitStart);
    await db.exec(migration.slice(
      splitStart, migration.indexOf(';', splitGrant) + 1
    ));

    const splitPayment = '00000000-0000-0000-0000-000000000201';
    const splitRequest = '00000000-0000-0000-0000-000000000202';
    const splitCustomer = '00000000-0000-0000-0000-000000000203';
    const splitProvider = '00000000-0000-0000-0000-000000000204';

    await db.query(
      `INSERT INTO service_requests
       (id,customer_id,provider_id,status,customer_confirmed_at)
       VALUES ($1,$2,$3,'work_completed',now())`,
      [splitRequest, splitCustomer, splitProvider]
    );

    await db.query(
      `INSERT INTO service_payments
       (id,request_id,customer_id,provider_id,authorized_amount,
        marketplace_fee_percent,marketplace_fee_amount,provider_amount)
       VALUES ($1,$2,$3,$4,125,15,18.75,106.25)`,
      [splitPayment, splitRequest, splitCustomer, splitProvider]
    );

    const settleSplit = async () => (
      await db.query(
        'SELECT public.record_verified_split_payment($1) AS settled',
        [splitPayment]
      )
    ).rows[0].settled;

    // No successful cards: payment and job must remain unfinished.
    assert.equal(await settleSplit(), false);

    const part1 = '00000000-0000-0000-0000-000000000205';
    const part2 = '00000000-0000-0000-0000-000000000206';

    await db.query(
      `INSERT INTO service_payment_parts
       (id,service_payment_id,payment_status,stripe_payment_intent_id,
        stripe_charge_id,amount_cents)
       VALUES ($1,$2,'succeeded','pi_split1','ch_split1',6000)`,
      [part1, splitPayment]
    );

    // Only one successful card: settlement must fail.
    assert.equal(await settleSplit(), false);

    await db.query(
      `INSERT INTO service_payment_parts
       (id,service_payment_id,payment_status,stripe_payment_intent_id,
        stripe_charge_id,amount_cents)
       VALUES ($1,$2,'succeeded','pi_split2','ch_split2',6000)`,
      [part2, splitPayment]
    );

    // Both cards succeeded, but $120 does not equal the $125 bill.
    assert.equal(await settleSplit(), false);

    await db.query(
      'UPDATE service_payment_parts SET amount_cents=6500 WHERE id=$1',
      [part2]
    );

    // $60 + $65 = $125, with the correct marketplace fee.
    assert.equal(await settleSplit(), true);

    let splitResult = await db.query(
      'SELECT payment_status,paid_at FROM service_payments WHERE id=$1',
      [splitPayment]
    );
    assert.equal(splitResult.rows[0].payment_status, 'paid');
    assert.ok(splitResult.rows[0].paid_at);

    splitResult = await db.query(
      'SELECT status FROM service_requests WHERE id=$1',
      [splitRequest]
    );
    assert.equal(splitResult.rows[0].status, 'completed');

    // Repeated successful settlement must be idempotent.
    assert.equal(await settleSplit(), true);

    console.log(
      'PASS: split payment incomplete, incorrect total, successful settlement, duplicate replay'
    );

    const payment = '00000000-0000-0000-0000-000000000101';
    const request = '00000000-0000-0000-0000-000000000102';
    const customer = '00000000-0000-0000-0000-000000000103';
    const provider = '00000000-0000-0000-0000-000000000104';

    await db.query(
      `INSERT INTO service_requests
       (id, customer_id, provider_id, status, customer_confirmed_at)
       VALUES ($1,$2,$3,'work_completed',now())`,
      [request, customer, provider]
    );

    await db.query(
      `INSERT INTO service_payments
       (id,request_id,customer_id,provider_id,stripe_payment_intent_id,authorized_amount)
       VALUES ($1,$2,$3,$4,'pi_test123',125)`,
      [payment, request, customer, provider]
    );

    const settle = (pi = 'pi_test123', charge = 'ch_test123') =>
      db.query(
        'SELECT public.record_verified_single_payment($1,$2,$3) AS settled',
        [payment, pi, charge]
      );

    assert.equal((await settle()).rows[0].settled, true);

    let result = await db.query(
      'SELECT payment_status,stripe_charge_id,paid_at FROM service_payments WHERE id=$1',
      [payment]
    );
    assert.equal(result.rows[0].payment_status, 'paid');
    assert.equal(result.rows[0].stripe_charge_id, 'ch_test123');
    assert.ok(result.rows[0].paid_at);

    result = await db.query('SELECT status FROM service_requests WHERE id=$1', [request]);
    assert.equal(result.rows[0].status, 'completed');

    assert.equal((await settle()).rows[0].settled, true);
    await assert.rejects(() => settle('pi_wrong', 'ch_test123'));
    await assert.rejects(() => settle('pi_test123', 'ch_wrong'));

    console.log('PASS: single payment settlement, duplicate replay, invalid identifiers');
  } finally {
    await db.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
