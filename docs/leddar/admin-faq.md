---
title: Leddar Admin FAQ
audience: [admin]
---

# Leddar Admin FAQ

## How do I approve a new brand or artisan account?

New accounts are pending until approved. Pending users with verified emails
appear in the admin dashboard. Approve them from there; the API endpoint is
`PATCH /admin/approve/:userId`. Until a user is approved, their login fails
with "Awaiting admin approval".

## Which orders need an artisan assigned?

On **Jobs** (`/jobs`), the **Needs Assignment** tab lists:

- sample orders in `FLAT_FEE_PAID` status (the brand paid the sample fee)
- production orders in `IN_PRODUCTION` status (only after the brand paid the production balance)

## Why can't I assign a particular artisan?

Sample jobs can only go to artisans whose **NIN is verified**. Artisans who
already declined or let a job expire for that order are flagged in the picker.

## What happens when an artisan doesn't accept a job in time?

A background task runs every 15 minutes. Assigned jobs past their acceptance
deadline are marked **EXPIRED**, the order is rolled back for reassignment, and
admins get an email, WhatsApp message and in-app notification to reassign it.

## How do acceptance windows work?

**Commission Settings** has two values: **Sample Acceptance Hours** and
**Production Acceptance Hours**. They set how long an artisan has to accept
each kind of job.

## How do I review a sample video?

From the **Sample Ready** tab on Jobs:

- **Approve** forwards the video to the brand for their review.
- **Reject** notifies the artisan to re-upload.

## How do I review a production video?

- **Approve** moves the order to `PENDING_DELIVERY`. After approval the reject option is hidden permanently.
- **Reject** asks the artisan to re-upload.

## What is the full order lifecycle from the admin side?

1. The brand pays the sample fee.
2. Assign the sample job (the artisan's NIN must be verified).
3. The artisan uploads the sample video; you approve it (forward to brand) or reject it.
4. The brand approves the sample. Mark the sample complete: a production order is created as `SUBMITTED`.
5. Enter production pricing.
6. The brand pays the production balance. The order becomes `IN_PRODUCTION` and the production job is auto-assigned to the same artisan.
7. Release Stage 1 (materials).
8. The artisan uploads the production video; approve it.
9. Mark Pending Delivery → Dispatched → Delivered.
10. Release Stage 2 (service fee).

## When can I release artisan payments?

On **Payments** (`/payments`):

- **Stage 1 (materials)**: after the artisan accepts the production job.
- **Stage 2 (service fee)**: once the job is `DELIVERED` or `COMPLETED`.

Release is blocked while the order has a payment still `PENDING`.

## How do commission settings work?

**Commission Settings** (`/commission-settings`) holds the Admin Rate, Artisan
Stage 1 Rate, Artisan Stage 2 Rate, Sample Admin Rate and the two acceptance
windows. Rates are stored as decimals (0.40 = 40%). New rates apply only to
orders created **after** the change, because each order keeps a snapshot of the
rates (`snapshotStage1Rate`, `snapshotStage2Rate`).

## How are VAT and payouts calculated?

VAT is 7.5%. The escrow balance Paystack collects includes VAT, so commission
and stage splits are calculated on the VAT-exclusive amount
(escrow balance ÷ 1.075). The VAT summary is available from the payments
section.

## Which webhooks does the server rely on?

- **Paystack** (`/api/v1/payments/webhook`): handles `charge.success`, advances the order and creates the escrow record.
- **QoreID** (`/api/v1/webhooks/qoreid`): delivers artisan address verification results. Turn on Network Downtime Handling in QoreID so requests queue during NIMC outages.

## A brand paid but the order didn't move. What should I check?

Order status advances from the Paystack `charge.success` webhook. Check that the
webhook URL is configured in the Paystack dashboard and that the server is
receiving it. Then look up the payment in **Payment History** (`/payment-history`).
