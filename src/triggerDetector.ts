/**
 * triggerDetector.ts
 * Checks an incoming message against all active campaigns and returns
 * the first match (or a no-match result).
 */

import { Campaign } from './storage';

export interface TriggerResult {
  matched: boolean;
  suffix: string;
  campaignName: string;
}

// Strip invisible Unicode direction/zero-width chars that WhatsApp sometimes injects
function normalize(s: string): string {
  return s
    .replace(/[​-‏﻿‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectTrigger(
  messageBody: string,
  activeCampaigns: Campaign[],
): TriggerResult {
  const text = normalize(messageBody);

  for (const campaign of activeCampaigns) {
    if (text === normalize(campaign.triggerPhrase)) {
      return {
        matched: true,
        suffix: campaign.suffix,
        campaignName: campaign.name,
      };
    }
  }

  return { matched: false, suffix: '', campaignName: '' };
}
