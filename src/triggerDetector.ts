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

export function detectTrigger(
  messageBody: string,
  activeCampaigns: Campaign[],
): TriggerResult {
  const text = messageBody.trim();

  for (const campaign of activeCampaigns) {
    if (text === campaign.triggerPhrase) {
      return {
        matched: true,
        suffix: campaign.suffix,
        campaignName: campaign.name,
      };
    }
  }

  return { matched: false, suffix: '', campaignName: '' };
}
