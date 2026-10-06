-- Entitlement is server-controlled. Clients cannot set or change it.
ALTER TABLE devices ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro'));
