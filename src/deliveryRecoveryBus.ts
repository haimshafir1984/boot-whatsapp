import { EventEmitter } from 'events';

/**
 * In-process events of delivery recovery. A separate module so both the controller (deliveryRecovery.ts) and the message
 * flow can use it without importing each other.
 *   'released'   - a recovery hold ended because its message was resolved (evidence / retry / recoverable_failed)
 *   'superseded' - the participant sent a fresh trigger: the unresolved message was abandoned and its hold removed
 *   'replayHeld' - Baileys messages held meanwhile must be processed again (admin "requeue")
 */
export const deliveryRecoveryBus = new EventEmitter();
