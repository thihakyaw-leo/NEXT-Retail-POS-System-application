-- Migration: Remove legacy columns from products table
-- The stock_quantity and reorder_point are now store-specific and managed in store_stock.

ALTER TABLE products DROP COLUMN stock_quantity;
ALTER TABLE products DROP COLUMN reorder_point;
