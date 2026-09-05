-- =============================================================================
-- 0002_chart_of_accounts.sql
--
-- Sign convention (stated once, relied on everywhere):
--   assets and expenses      increase POSITIVE
--   liabilities, equity,
--   income                   increase NEGATIVE
-- Consequence: every balanced entry sums to exactly zero per commodity, which
-- is precisely what the deferred balance trigger checks. There is no separate
-- "debit"/"credit" column to get backwards.
--
-- The customer's own money lives in customer-book accounts. The outside world
-- (the market, the bank) is represented by house "external" accounts which
-- absorb the far leg of every entry. That is what lets a trade balance in two
-- commodities at once: the market hands us shares and takes dollars, so the
-- market account holds -shares and +dollars on the same entry.
-- =============================================================================

INSERT INTO accounts (code, name, type, commodity_class, is_customer_book, description) VALUES

-- ---------------------------------------------------------------------------
-- Customer cash. Three buckets, because "cash" is not one number.
-- ---------------------------------------------------------------------------
('assets:cash:settled',
 'Settled cash',
 'asset', 'usd', true,
 'Cash that has actually settled at the custodian. This is the ONLY bucket a '
 'customer may withdraw from.'),

('assets:cash:unsettled_proceeds',
 'Unsettled sale proceeds',
 'asset', 'usd', true,
 'Proceeds from a sale that has traded but not yet settled (T+1). US rules let '
 'you BUY with these but not WITHDRAW them — withdrawing unsettled proceeds is '
 'free-riding. Modelling the gap rather than hiding it.'),

('assets:cash:pending_deposit',
 'Deposit in flight',
 'asset', 'usd', true,
 'ACH debit initiated but not yet good funds. Not investable, not withdrawable. '
 'This is the bucket a bounced deposit reverses out of.'),

-- ---------------------------------------------------------------------------
-- Customer positions. The two dimensions, side by side and never mixed.
-- ---------------------------------------------------------------------------
('assets:positions',
 'Positions (units)',
 'asset', 'instrument', true,
 'Share units to 6dp. UNITS ONLY — this account can never hold cents. Market '
 'value is units x price computed at read time and is deliberately not stored.'),

('assets:positions:cost',
 'Positions (cost basis)',
 'asset', 'usd', true,
 'Cost basis in cents for the units above, commissions capitalised into basis '
 'per US tax treatment. Unrealised gain = (units x price) - cost, and is NOT a '
 'ledger entry because nothing has happened yet.'),

('assets:receivable:dividend',
 'Dividend receivable',
 'asset', 'usd', true,
 'Entitlement earned on ex-date, cash not yet arrived. This account is exactly '
 'the gap between ex-date and pay-date.'),

-- ---------------------------------------------------------------------------
-- Customer liabilities
-- ---------------------------------------------------------------------------
('liabilities:trade_payable',
 'Trade payable',
 'liability', 'usd', true,
 'Owed to the custodian for a buy that has traded but not yet settled.'),

('liabilities:withdrawal_payable',
 'Withdrawal payable',
 'liability', 'usd', true,
 'Withdrawal approved and owed to the customer, not yet paid out on the rail.'),

-- ---------------------------------------------------------------------------
-- Customer income and expense
-- ---------------------------------------------------------------------------
('income:realized_gain',
 'Realised gain / loss',
 'income', 'usd', true,
 'Falls out of the balance requirement on a sell: proceeds minus the basis of '
 'the lots consumed. Never computed twice, never stored twice.'),

('income:dividend',
 'Dividend income',
 'income', 'usd', true,
 'Recognised on ex-date, when the entitlement is earned — not on pay-date, '
 'when the cash happens to arrive.'),

('expenses:fees',
 'Fees',
 'expense', 'usd', true,
 'Advisory and platform fees. Trade commissions are NOT here: they capitalise '
 'into cost basis.'),

-- ---------------------------------------------------------------------------
-- House accounts: the outside world, and the penny.
-- ---------------------------------------------------------------------------
('equity:external:market',
 'External — market counterparty',
 'equity', 'any', false,
 'The far side of every trade and corporate action. Holds both dimensions: on '
 'a buy it is -units and +cents on the same entry, which is what makes a '
 'two-commodity trade balance.'),

('equity:external:bank',
 'External — bank counterparty',
 'equity', 'usd', false,
 'The far side of every ACH deposit, return and withdrawal.'),

('equity:opening_balances',
 'Opening balances',
 'equity', 'any', false,
 'Used only by the seed script to stand up demo history from zero.'),

('expenses:rounding',
 'Rounding residual',
 'expense', 'usd', false,
 'Where the penny goes. Allocation uses largest-remainder; any residual that '
 'cannot be fairly allocated is absorbed by the house here, never by the '
 'customer. Deterministic: same inputs, same penny, forever.')

ON CONFLICT (code) DO NOTHING;
