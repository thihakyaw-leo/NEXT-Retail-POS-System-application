PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	address TEXT,
	currency_code TEXT NOT NULL DEFAULT 'USD',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
	id TEXT PRIMARY KEY,
	store_id TEXT NOT NULL,
	name TEXT NOT NULL,
	barcode TEXT NOT NULL,
	description TEXT,
	price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
	stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
	image_key TEXT,
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
	UNIQUE (store_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_products_store_name
	ON products(store_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_products_store_barcode
	ON products(store_id, barcode);

CREATE TABLE IF NOT EXISTS transactions (
	id TEXT PRIMARY KEY,
	store_id TEXT NOT NULL,
	receipt_number TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'completed',
	item_count INTEGER NOT NULL CHECK (item_count > 0),
	subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
	total_amount_cents INTEGER NOT NULL CHECK (total_amount_cents >= 0),
	cash_received_cents INTEGER NOT NULL CHECK (cash_received_cents >= total_amount_cents),
	change_due_cents INTEGER NOT NULL CHECK (change_due_cents >= 0),
	created_at TEXT NOT NULL,
	FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_store_created
	ON transactions(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transaction_items (
	id TEXT PRIMARY KEY,
	transaction_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	product_name_snapshot TEXT NOT NULL,
	barcode_snapshot TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK (quantity > 0),
	unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
	line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
	FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction
	ON transaction_items(transaction_id);

INSERT OR IGNORE INTO stores (id, name, address, currency_code)
VALUES ('store-hq', 'Harbor Retail Flagship', '101 Market Street, San Francisco, CA', 'USD');

INSERT OR IGNORE INTO products (id, store_id, name, barcode, description, price_cents, stock_quantity)
VALUES
	('prod-arabica-1kg', 'store-hq', 'Arabica Beans 1kg', '885100100001', 'Single-origin medium roast beans.', 2400, 18),
	('prod-milk-1l', 'store-hq', 'Whole Milk 1L', '885100100002', 'Chilled dairy milk for cafe service.', 325, 32),
	('prod-croissant', 'store-hq', 'Chocolate Croissant', '885100100003', 'Buttery pastry with dark chocolate.', 475, 20),
	('prod-water', 'store-hq', 'Sparkling Water', '885100100004', '330ml sparkling mineral water.', 225, 28),
	('prod-muffin', 'store-hq', 'Blueberry Muffin', '885100100005', 'Fresh baked blueberry muffin.', 390, 14),
	('prod-juice', 'store-hq', 'Organic Orange Juice', '885100100006', 'Cold-pressed orange juice.', 550, 11);
