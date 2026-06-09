DROP TABLE IF EXISTS products;

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  size TEXT,
  color TEXT,
  category TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  sizes TEXT[] := ARRAY['XS', 'S', 'M', 'L', 'XL'];
  colors TEXT[] := ARRAY['negro', 'blanco', 'azul', 'rojo', 'verde', 'beige'];
  categories TEXT[] := ARRAY['camisetas', 'pantalones', 'vestidos', 'chaquetas', 'accesorios'];
  i INTEGER;
BEGIN
  FOR i IN 1..300 LOOP
    INSERT INTO products (
      sku,
      name,
      description,
      price,
      stock,
      size,
      color,
      category,
      updated_at
    ) VALUES (
      'SKU-' || LPAD(i::text, 5, '0'),
      'Producto ' || i,
      'Descripcion del producto ' || i || ' para catalogo ecommerce en español.',
      (10 + (i % 190))::numeric + 0.99,
      (i % 25),
      sizes[1 + (i % array_length(sizes, 1))],
      colors[1 + (i % array_length(colors, 1))],
      categories[1 + (i % array_length(categories, 1))],
      NOW() - ((i % 30) || ' days')::interval
    )
    ON CONFLICT (sku) DO NOTHING;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_user') THEN
    CREATE ROLE readonly_user LOGIN PASSWORD 'readonly_pass';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'write_user') THEN
    CREATE ROLE write_user LOGIN PASSWORD 'write_pass';
  END IF;
END $$;

GRANT CONNECT ON DATABASE catalog TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly_user;

GRANT CONNECT ON DATABASE catalog TO write_user;
GRANT USAGE ON SCHEMA public TO write_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO write_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO write_user;
