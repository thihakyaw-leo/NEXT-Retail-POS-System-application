CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('admin', 'store_manager', 'cashier')),
	store_id TEXT,
	password_hash TEXT NOT NULL,
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (store_id) REFERENCES stores(id)
);

ALTER TABLE transactions
	ADD COLUMN user_id TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS store_stock (
	store_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
	reorder_point INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (store_id, product_id),
	FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_store_stock_store_reorder
	ON store_stock(store_id, stock_quantity, reorder_point);

CREATE TABLE IF NOT EXISTS transfers (
	id TEXT PRIMARY KEY,
	transfer_number TEXT NOT NULL UNIQUE,
	from_store_id TEXT NOT NULL,
	to_store_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('requested', 'approved')),
	note TEXT,
	requested_by_user_id TEXT NOT NULL,
	approved_by_user_id TEXT,
	created_at TEXT NOT NULL,
	approved_at TEXT,
	FOREIGN KEY (from_store_id) REFERENCES stores(id),
	FOREIGN KEY (to_store_id) REFERENCES stores(id),
	FOREIGN KEY (requested_by_user_id) REFERENCES users(id),
	FOREIGN KEY (approved_by_user_id) REFERENCES users(id),
	CHECK (from_store_id <> to_store_id)
);

CREATE TABLE IF NOT EXISTS transfer_items (
	id TEXT PRIMARY KEY,
	transfer_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	product_name_snapshot TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK (quantity > 0),
	FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer
	ON transfer_items(transfer_id);

INSERT OR IGNORE INTO stores (id, name, address, currency_code)
VALUES ('store-downtown', 'Harbor Retail Downtown', '44 Howard Street, San Francisco, CA', 'USD');

INSERT OR IGNORE INTO store_stock (store_id, product_id, stock_quantity, reorder_point, updated_at)
SELECT
	store_id,
	id,
	stock_quantity,
	reorder_point,
	updated_at
FROM products;

INSERT OR IGNORE INTO store_stock (store_id, product_id, stock_quantity, reorder_point, updated_at)
VALUES
	('store-downtown', 'prod-arabica-1kg', 7, 6, CURRENT_TIMESTAMP),
	('store-downtown', 'prod-milk-1l', 14, 10, CURRENT_TIMESTAMP),
	('store-downtown', 'prod-croissant', 9, 8, CURRENT_TIMESTAMP),
	('store-downtown', 'prod-water', 6, 8, CURRENT_TIMESTAMP),
	('store-downtown', 'prod-muffin', 5, 7, CURRENT_TIMESTAMP),
	('store-downtown', 'prod-juice', 4, 6, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO users (id, email, name, role, store_id, password_hash)
VALUES
	('user-admin', 'admin@nextpos.test', 'Avery Admin', 'admin', NULL, '030bcb6129fe35a5548873e679e9f3728724e7faa013f683801c09fbb23d8664'),
	('user-manager-hq', 'manager@nextpos.test', 'Morgan Manager', 'store_manager', 'store-hq', 'eb25dfbd636ea739e227d530e5b3ea7e28abb479a89e8a2000b75b02a1184efb'),
	('user-cashier-hq', 'cashier@nextpos.test', 'Casey Cashier', 'cashier', 'store-hq', 'cae487dbc519a04be2cfa6895a72f4a0637e6daab7136048146cb23a43b22d21'),
	('user-manager-downtown', 'manager.downtown@nextpos.test', 'Dana Downtown', 'store_manager', 'store-downtown', '3675b3114868a4196195ad7d6e96b076d1ee7ff139ad601e3925ef9823828265');
