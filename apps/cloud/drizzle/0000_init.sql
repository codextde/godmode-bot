CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "device_access" (
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_access_device_id_user_id_pk" PRIMARY KEY("device_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"instance_id" text NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"browser_access" boolean DEFAULT true NOT NULL,
	"phone_access" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role_id" text NOT NULL,
	"invited_by" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"secret_hash" text NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"device_id" text,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"code_hash" text,
	"next" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"interval" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"stripe_price_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"highlighted" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"stripe_product_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text,
	"price_id" text,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"status" text NOT NULL,
	"interval" text,
	"amount" integer,
	"currency" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"livemode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_device_id_day_pk" PRIMARY KEY("device_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"plan_override_id" text,
	"plan_override_until" timestamp with time zone,
	"invited_by" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_access" ADD CONSTRAINT "device_access_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_access" ADD CONSTRAINT "device_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "device_access_user_idx" ON "device_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_instance_key" ON "devices" USING btree ("user_id","instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_key" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "link_requests_code_key" ON "link_requests" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "login_tokens_token_key" ON "login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_tokens_email_idx" ON "login_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "plan_prices_plan_idx" ON "plan_prices" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_prices_stripe_key" ON "plan_prices" USING btree ("stripe_price_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_key" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_user_day_idx" ON "usage_daily" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_stripe_customer_key" ON "users" USING btree ("stripe_customer_id");