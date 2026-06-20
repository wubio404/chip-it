-- CreateEnum
CREATE TYPE "PosType" AS ENUM ('FOODICS', 'DB_INJECTOR', 'PRINT_FALLBACK');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAYMENT_PENDING', 'CONFIRMED', 'ROUTING', 'INJECTED', 'PRINTED', 'FULFILLED', 'CANCELLED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'APPLE_PAY', 'CASH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED');

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "primary_color" TEXT NOT NULL DEFAULT '#000000',
    "default_locale" TEXT NOT NULL DEFAULT 'ar',
    "pos_type" "PosType" NOT NULL DEFAULT 'PRINT_FALLBACK',
    "pos_credentials" JSONB,
    "db_config" JSONB,
    "paymob_config" JSONB,
    "stock_buffer" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "nfc_slug" TEXT NOT NULL,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "pos_sku" TEXT,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "description_ar" TEXT,
    "price" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "category_ar" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "stock_count" INTEGER,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "table_label" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "items" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CARD',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "payment_ref" TEXT,
    "refund_ref" TEXT,
    "pos_ref" TEXT,
    "routing_tier" TEXT,
    "cancel_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "last_heartbeat" TIMESTAMP(3),
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "current_tier" TEXT,
    "schema_ok" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Venue_slug_key" ON "Venue"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Table_nfc_slug_key" ON "Table"("nfc_slug");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_venue_id_key" ON "Agent"("venue_id");

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
