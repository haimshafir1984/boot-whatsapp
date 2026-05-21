import { saveContactToGoogle } from './googleContacts';
import { saveContactToICloud } from './icloudContacts';
import { Storage, ContactSaveJob } from './storage';

const MAX_ATTEMPTS = 3;
const IDLE_DELAY_MS = 2_000;
const SUCCESS_DELAY_MS = 750;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

let workerStarted = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1))];
}

async function saveJob(storage: Storage, job: ContactSaveJob): Promise<void> {
  const settings = storage.getAdminSettings();
  const provider = job.provider;

  if (provider === 'google') {
    await saveContactToGoogle(job.name, `+${job.phone}`);
  } else if (provider === 'icloud') {
    await saveContactToICloud(settings.icloudEmail, settings.icloudPassword, job.name, `+${job.phone}`);
  } else {
    console.log(`   Manual mode: contact recorded locally (${job.phone}).`);
  }

  storage.markContactSaved(job.phone, job.name);
}

async function processOne(storage: Storage, job: ContactSaveJob): Promise<void> {
  const attemptJob = storage.markContactSaveAttempt(job.id);
  if (!attemptJob) return;

  try {
    await saveJob(storage, attemptJob);
    console.log(`   Contact queue: saved ${attemptJob.phone} as "${attemptJob.name}".`);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const updated = storage.markContactSaveFailed(
      attemptJob.id,
      message,
      MAX_ATTEMPTS,
      retryDelay(attemptJob.attempts),
    );

    if (updated?.status === 'failed') {
      console.error(`   Contact queue: failed ${attemptJob.phone} after ${attemptJob.attempts} attempts:`, message);
    } else {
      console.warn(`   Contact queue: retry scheduled for ${attemptJob.phone}:`, message);
    }
  }
}

export function startContactSaveQueue(storage: Storage): void {
  if (workerStarted) return;
  workerStarted = true;

  void (async () => {
    console.log('   Contact queue worker started.');
    while (true) {
      const job = storage.getDueContactSaveJob();
      if (!job) {
        await sleep(IDLE_DELAY_MS);
        continue;
      }

      await processOne(storage, job);
      await sleep(SUCCESS_DELAY_MS);
    }
  })();
}
