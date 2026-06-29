/**
 * triggerDetector.ts
 * Checks an incoming message against all active campaigns and returns
 * the first match (or a no-match result).
 */

import { Campaign } from './storage';

export interface TriggerResult {
  matched: boolean;
  campaignId: string;
  suffix: string;
  campaignName: string;
  referralCode?: string;
}

// Strip invisible Unicode direction/zero-width chars that WhatsApp sometimes injects
export function extractReferralCode(messageBody: string): string {
  const match = messageBody.match(/הגעתי דרך (\d+)/);
  return match?.[1] ?? '';
}

function normalize(s: string): string {
  return s
    .replace(/[​-‏﻿‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
    .trim();
}

export function detectTrigger(
  messageBody: string,
  activeCampaigns: Campaign[],
): TriggerResult {
  const text = normalize(messageBody);
  let bestMatch: { campaign: Campaign; triggerText: string } | null = null;

  for (const campaign of activeCampaigns) {
    const triggerText = normalize(campaign.triggerPhrase);
    if (triggerText && text.includes(triggerText)) {
      if (!bestMatch || triggerText.length >= bestMatch.triggerText.length) {
        bestMatch = { campaign, triggerText };
      }
    }
  }

  if (bestMatch) {
    return {
      matched: true,
      campaignId: bestMatch.campaign.id,
      suffix: bestMatch.campaign.suffix,
      campaignName: bestMatch.campaign.name,
      referralCode: extractReferralCode(messageBody),
    };
  }

  return { matched: false, campaignId: '', suffix: '', campaignName: '' };
}
