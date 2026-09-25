-- Most used parts: how many of each part number every shop used per month. Counts only: no customers, ticket ids or
-- prices. A shop re-sending a month replaces what it sent before for that month.
CREATE TABLE part_usage (
  install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  month      text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  number_key text NOT NULL,
  number     text NOT NULL,
  brand      text,
  qty        int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  tickets    int NOT NULL DEFAULT 0 CHECK (tickets >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, month, number_key)
);
CREATE INDEX part_usage_month ON part_usage (month, number_key);
