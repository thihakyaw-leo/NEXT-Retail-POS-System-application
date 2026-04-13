ALTER TABLE products
	ADD COLUMN reorder_point INTEGER NOT NULL DEFAULT 6 CHECK (reorder_point >= 0);

CREATE TABLE IF NOT EXISTS suppliers (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	contact_name TEXT,
	email TEXT,
	phone TEXT,
	lead_time_days INTEGER NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
	id TEXT PRIMARY KEY,
	store_id TEXT NOT NULL,
	supplier_id TEXT NOT NULL,
	po_number TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('draft', 'received')),
	notes TEXT,
	total_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_cents >= 0),
	received_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
	FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_store_created
	ON purchase_orders(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS po_items (
	id TEXT PRIMARY KEY,
	purchase_order_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	product_name_snapshot TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK (quantity > 0),
	unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
	line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
	batch_code TEXT NOT NULL,
	expiry_date TEXT,
	FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_po_items_purchase_order
	ON po_items(purchase_order_id);

CREATE TABLE IF NOT EXISTS batches (
	id TEXT PRIMARY KEY,
	store_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	supplier_id TEXT,
	purchase_order_id TEXT,
	batch_code TEXT NOT NULL,
	expiry_date TEXT,
	received_quantity INTEGER NOT NULL CHECK (received_quantity > 0),
	remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
	unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
	created_at TEXT NOT NULL,
	FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id),
	FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
	FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_product_expiry
	ON batches(product_id, expiry_date);

CREATE TABLE IF NOT EXISTS stock_movements (
	id TEXT PRIMARY KEY,
	store_id TEXT NOT NULL,
	product_id TEXT NOT NULL,
	batch_id TEXT,
	source_type TEXT NOT NULL CHECK (source_type IN ('purchase_order', 'stock_adjustment', 'sale', 'offline_sync')),
	source_id TEXT NOT NULL,
	movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjust')),
	quantity_delta INTEGER NOT NULL CHECK (quantity_delta != 0),
	reason TEXT,
	resulting_stock_quantity INTEGER NOT NULL CHECK (resulting_stock_quantity >= 0),
	created_at TEXT NOT NULL,
	FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
	FOREIGN KEY (product_id) REFERENCES products(id),
	FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created
	ON stock_movements(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_deliveries (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	transport TEXT NOT NULL CHECK (transport IN ('mock', 'resend')),
	recipient TEXT NOT NULL,
	subject TEXT NOT NULL,
	status TEXT NOT NULL,
	provider_message_id TEXT,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_created
	ON email_deliveries(created_at DESC);

INSERT OR IGNORE INTO suppliers (id, name, contact_name, email, phone, lead_time_days)
VALUES
	('sup-harbor-beans', 'Harbor Beans Supply Co.', 'Marco Alvarez', 'orders@harborbeans.example', '+1-415-555-0112', 4),
	('sup-sunrise-dairy', 'Sunrise Dairy Partners', 'Lena Ford', 'dispatch@sunrisedairy.example', '+1-415-555-0177', 2),
	('sup-bakecraft', 'Bakecraft Artisan Foods', 'Noah Chen', 'purchasing@bakecraft.example', '+1-415-555-0134', 3);

UPDATE products
SET reorder_point = CASE id
	WHEN 'prod-arabica-1kg' THEN 8
	WHEN 'prod-milk-1l' THEN 12
	WHEN 'prod-croissant' THEN 10
	WHEN 'prod-water' THEN 10
	WHEN 'prod-muffin' THEN 15
	WHEN 'prod-juice' THEN 12
	ELSE reorder_point
END;
