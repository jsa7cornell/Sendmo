// SendMo Email Templates
// Using React Email or simple HTML templates

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const emailTemplates = {
  // ============================================
  // RECEIVER EMAILS
  // ============================================

  label_created_receiver: {
    subject: (data: { itemDescription: string }) => `Your shipping label for "${data.itemDescription}" is ready`,
    template: `
      <h1>Your shipping label is ready!</h1>
      <p>You created a prepaid shipping label for: <strong>{{itemDescription}}</strong></p>

      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3>Share this link with the sender:</h3>
        <a href="{{shareUrl}}" style="font-size: 16px; color: #00E5CC;">{{shareUrl}}</a>
        <p style="font-size: 14px; color: #666; margin-top: 10px;">
          Send via text, email, or Facebook Messenger
        </p>
      </div>

      <h3>Details:</h3>
      <ul>
        <li>Estimated size: {{estimatedSize}}</li>
        <li>Estimated shipping: ${{estimatedCost}}</li>
        <li>Delivering to: {{destinationCity}}, {{destinationState}}</li>
      </ul>

      <p style="font-size: 14px; color: #666;">
        You'll get an email when the sender prints the label and ships the item.
      </p>

      <p style="margin-top: 30px;">
        <a href="{{trackingUrl}}" style="color: #00E5CC;">Track this shipment</a>
      </p>
    `
  },

  label_printed_receiver: {
    subject: (data: { itemDescription: string }) => `Your item "${data.itemDescription}" has been shipped!`,
    template: `
      <h1>Your item has been shipped!</h1>
      <p>The sender has printed the label and shipped: <strong>{{itemDescription}}</strong></p>

      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3>Shipping Details:</h3>
        <ul style="list-style: none; padding: 0;">
          <li><strong>Carrier:</strong> {{carrier}} {{service}}</li>
          <li><strong>Tracking #:</strong> {{trackingNumber}}</li>
          <li><strong>Estimated delivery:</strong> {{estimatedDeliveryDate}}</li>
          <li><strong>Actual size:</strong> {{actualSize}} {{#if sizeMismatch}}<span style="color: #ff6b6b;">(different from estimate)</span>{{/if}}</li>
          <li><strong>Shipping cost:</strong> ${{actualShippingCost}} {{#if costDifference}}<span style="color: #666;">(estimated: ${{estimatedShippingCost}})</span>{{/if}}</li>
        </ul>
      </div>

      {{#if sizeMismatch}}
      <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
        <p style="margin: 0;"><strong>Note:</strong> The actual package size differs from your estimate. The final shipping cost may be adjusted.</p>
      </div>
      {{/if}}

      <p style="margin-top: 30px;">
        <a href="{{trackingUrl}}" style="display: inline-block; background: #00E5CC; color: #0A0E27; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Track Your Package
        </a>
      </p>

      <p style="font-size: 14px; color: #666; margin-top: 20px;">
        We'll send you another email when your package is delivered.
      </p>
    `
  },

  in_transit_receiver: {
    subject: (data: { itemDescription: string }) => `Your package "${data.itemDescription}" is on the way`,
    template: `
      <h1>Your package is in transit</h1>
      <p><strong>{{itemDescription}}</strong> is on its way to you!</p>

      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Current Status:</strong> {{currentStatus}}</p>
        <p><strong>Last Location:</strong> {{lastLocation}}</p>
        <p><strong>Estimated Delivery:</strong> {{estimatedDeliveryDate}}</p>
      </div>

      <p style="margin-top: 30px;">
        <a href="{{trackingUrl}}" style="color: #00E5CC;">View live tracking</a>
      </p>
    `
  },

  delivered_receiver: {
    subject: (data: { itemDescription: string }) => `Delivered: "${data.itemDescription}"`,
    template: `
      <h1>Your package has been delivered!</h1>
      <p><strong>{{itemDescription}}</strong> was delivered at {{deliveryTime}}</p>

      <div style="background: #e7f9f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #00E5CC;">
        <p style="margin: 0;"><strong>Delivered to:</strong> {{deliveryLocation}}</p>
        <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">{{deliveryDate}} at {{deliveryTime}}</p>
      </div>

      {{#if includesPayment}}
      <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0;"><strong>Payment Update:</strong> Funds will be released to the sender in 24 hours. If there's an issue with your item, please open a dispute before then.</p>
        <p style="margin-top: 10px;">
          <a href="{{disputeUrl}}" style="color: #0A0E27;">Report an issue</a>
        </p>
      </div>
      {{/if}}

      <p style="margin-top: 30px;">
        How was your experience? Rate the sender:
      </p>
      <p>
        <a href="{{ratingUrl}}" style="display: inline-block; background: #00E5CC; color: #0A0E27; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Leave a Rating
        </a>
      </p>
    `
  },

  // ============================================
  // SENDER EMAILS
  // ============================================

  label_ready_sender: {
    subject: (data: { itemDescription: string; receiverName: string }) => `Print your shipping label for ${data.receiverName}`,
    template: `
      <h1>Print your shipping label</h1>
      <p>{{receiverName}} is receiving: <strong>{{itemDescription}}</strong></p>

      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3>Shipping Details:</h3>
        <ul style="list-style: none; padding: 0;">
          <li><strong>Shipping to:</strong> {{destinationCity}}, {{destinationState}}</li>
          <li><strong>Estimated size:</strong> {{estimatedSize}}</li>
          <li><strong>Estimated cost:</strong> ${{estimatedCost}} (paid by receiver)</li>
        </ul>
      </div>

      <p style="margin: 30px 0;">
        <a href="{{printLabelUrl}}" style="display: inline-block; background: #00E5CC; color: #0A0E27; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Print Label & Ship
        </a>
      </p>

      <p style="font-size: 14px; color: #666;">
        Confirm the package size, print the label, attach it to your package, and drop it off at {{carrier}}
      </p>

      <p style="font-size: 14px; color: #666; margin-top: 20px;">
        This link expires in 7 days.
      </p>
    `
  },

  shipment_confirmed_sender: {
    subject: (data: { itemDescription: string }) => `Thank you for shipping "${data.itemDescription}"`,
    template: `
      <h1>Thanks for shipping!</h1>
      <p>Your label for <strong>{{itemDescription}}</strong> has been printed.</p>

      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Tracking #:</strong> {{trackingNumber}}</p>
        <p><strong>Carrier:</strong> {{carrier}} {{service}}</p>
        <p><strong>Expected delivery:</strong> {{estimatedDeliveryDate}}</p>
      </div>

      <p style="margin-top: 30px;">
        <a href="{{trackingUrl}}" style="color: #00E5CC;">Track shipment</a>
      </p>

      {{#if includesPayment}}
      <div style="background: #e7f9f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0;"><strong>Payment:</strong> ${{paymentAmount}} will be released to you 24 hours after delivery confirmation.</p>
      </div>
      {{/if}}

      <p style="font-size: 14px; color: #666; margin-top: 20px;">
        We'll notify you when the package is delivered.
      </p>
    `
  },

  delivered_sender: {
    subject: (data: { itemDescription: string }) => `Delivered: "${data.itemDescription}"`,
    template: `
      <h1>Package delivered!</h1>
      <p>Your package (<strong>{{itemDescription}}</strong>) has been delivered.</p>

      <div style="background: #e7f9f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0;"><strong>Delivered:</strong> {{deliveryDate}} at {{deliveryTime}}</p>
        <p style="margin: 10px 0 0 0;"><strong>Location:</strong> {{deliveryLocation}}</p>
      </div>

      {{#if includesPayment}}
      <div style="background: #e7f9f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #00E5CC;">
        <p style="margin: 0;"><strong>Payment Released!</strong></p>
        <p style="margin: 10px 0 0 0;">\${{paymentAmount}} has been transferred to your account.</p>
        <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">
          <a href="{{stripeUrl}}" style="color: #0A0E27;">View in Stripe</a>
        </p>
      </div>
      {{/if}}

      <p style="margin-top: 30px;">
        How was your experience with {{receiverName}}?
      </p>
      <p>
        <a href="{{ratingUrl}}" style="display: inline-block; background: #00E5CC; color: #0A0E27; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Leave a Rating
        </a>
      </p>
    `
  },

  // ============================================
  // VERIFICATION EMAILS
  // ============================================

  explicit_verification: {
    subject: (_data: Record<string, string>) => 'Verify your SendMo account',
    template: `
      <h1>Verify your email</h1>
      <p>Click the link below to verify your SendMo account:</p>

      <p style="margin: 30px 0;">
        <a href="{{verificationUrl}}" style="display: inline-block; background: #00E5CC; color: #0A0E27; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Verify Email
        </a>
      </p>

      <p style="font-size: 14px; color: #666; margin-top: 20px;">
        Or copy and paste this link:<br>
        {{verificationUrl}}
      </p>

      <p style="font-size: 14px; color: #666; margin-top: 30px;">
        If you didn't create a SendMo account, you can safely ignore this email.
      </p>
    `
  }
};

// ============================================
// Notification Timing Rules
// ============================================

export const notificationRules = {
  receiver: {
    label_created: 'immediate', // right after receiver creates label
    label_printed: 'immediate', // when sender completes and prints
    in_transit: 'first_scan', // when carrier first scans package
    out_for_delivery: 'immediate', // when out for delivery
    delivered: 'immediate', // when delivered
  },

  sender: {
    label_ready: 'immediate', // when receiver creates label (if sender email provided)
    shipment_confirmed: 'immediate', // after sender prints label
    in_transit: 'optional', // sender can opt in for tracking updates
    delivered: 'immediate', // when delivered
    payment_released: 'immediate', // when payment hits their account (Phase 2)
  }
};

// ============================================
// Implicit Verification Logic
// ============================================

export async function handleLinkClick(userId: string, linkType: string) {
  // When user clicks ANY link we send them (tracking, notification, etc.)
  // Mark their account as "linked" if currently "unverified"

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    console.warn(`handleLinkClick: user ${userId} not found`);
    return;
  }

  if (user.verificationStatus === 'unverified') {
    await prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: 'linked',
        verifiedAt: new Date(),
        verificationMethod: linkType // 'tracking_click', 'notification_click', etc.
      }
    });
  }
}

// ============================================
// Template Rendering Helper
// ============================================

export function renderEmailTemplate(
  templateName: keyof typeof emailTemplates,
  data: Record<string, any>
): { subject: string; html: string } {
  const template = emailTemplates[templateName];

  if (!template || !template.template) {
    throw new Error(`Email template "${templateName}" not found or has no template body`);
  }

  const subject = typeof template.subject === 'function'
    ? template.subject(data)
    : String(template.subject ?? '');

  let html = template.template;

  // Simple Handlebars-style replacement
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    html = html.replace(regex, String(data[key] ?? ''));
  });

  // Handle conditionals {{#if}}
  html = html.replace(/\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs, (_match, condition, content) => {
    return data[condition] ? content : '';
  });

  return { subject, html };
}
