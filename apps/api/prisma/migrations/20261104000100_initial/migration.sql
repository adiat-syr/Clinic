BEGIN;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'RECEPTIONIST');

-- CreateEnum
CREATE TYPE "AuthStage" AS ENUM ('CHALLENGE', 'AUTHENTICATED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('ru', 'kk');

-- CreateEnum
CREATE TYPE "ConsentMethod" AS ENUM ('WEB_CHECKBOX');

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_ciphertext" BYTEA,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_last_used_counter" BIGINT,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "auth_stage" "AuthStage" NOT NULL DEFAULT 'CHALLENGE',
    "mfa_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_kk" TEXT NOT NULL,
    "specialty_ru" TEXT NOT NULL,
    "specialty_kk" TEXT NOT NULL,
    "bio_ru" TEXT NOT NULL DEFAULT '',
    "bio_kk" TEXT NOT NULL DEFAULT '',
    "photo_asset_key" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_kk" TEXT NOT NULL,
    "description_ru" TEXT NOT NULL DEFAULT '',
    "description_kk" TEXT NOT NULL DEFAULT '',
    "duration_minutes" INTEGER NOT NULL,
    "price_kzt" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_services" (
    "doctor_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_services_pkey" PRIMARY KEY ("doctor_id","service_id")
);

-- CreateTable
CREATE TABLE "availability_windows" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "availability_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "reference" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_minutes_snapshot" INTEGER NOT NULL,
    "price_kzt_snapshot" DECIMAL(12,2) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "patient_name_ciphertext" BYTEA,
    "phone_ciphertext" BYTEA,
    "encryption_key_version" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "anonymized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_documents" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "text_ru" TEXT NOT NULL,
    "text_kk" TEXT NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "consent_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_consents" (
    "appointment_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locale" "Locale" NOT NULL,
    "method" "ConsentMethod" NOT NULL DEFAULT 'WEB_CHECKBOX',
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "appointment_consents_pkey" PRIMARY KEY ("appointment_id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key_hash" CHAR(64) NOT NULL,
    "request_hmac" CHAR(64) NOT NULL,
    "appointment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key_hash")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "request_id" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "staff_sessions_user_id_idx" ON "staff_sessions"("user_id");

-- CreateIndex
CREATE INDEX "staff_sessions_expires_at_idx" ON "staff_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_slug_key" ON "doctors"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "services_slug_key" ON "services"("slug");

-- CreateIndex
CREATE INDEX "doctor_services_service_id_idx" ON "doctor_services"("service_id");

-- CreateIndex
CREATE INDEX "availability_windows_doctor_id_starts_at_idx" ON "availability_windows"("doctor_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_reference_key" ON "appointments"("reference");

-- CreateIndex
CREATE INDEX "appointments_doctor_id_starts_at_idx" ON "appointments"("doctor_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_service_id_idx" ON "appointments"("service_id");

-- CreateIndex
CREATE INDEX "appointments_doctor_id_service_id_idx" ON "appointments"("doctor_id", "service_id");

-- CreateIndex
CREATE INDEX "appointments_status_starts_at_idx" ON "appointments"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "consent_documents_version_key" ON "consent_documents"("version");

-- CreateIndex
CREATE INDEX "appointment_consents_document_id_idx" ON "appointment_consents"("document_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_appointment_id_idx" ON "idempotency_keys"("appointment_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_created_at_idx" ON "audit_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_created_at_idx" ON "audit_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "doctor_services" ADD CONSTRAINT "doctor_services_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "doctor_services" ADD CONSTRAINT "doctor_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_id_service_id_fkey" FOREIGN KEY ("doctor_id", "service_id") REFERENCES "doctor_services"("doctor_id", "service_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointment_consents" ADD CONSTRAINT "appointment_consents_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "appointment_consents" ADD CONSTRAINT "appointment_consents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "consent_documents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


COMMIT;
