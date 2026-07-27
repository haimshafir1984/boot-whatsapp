import { config } from './config';
import { ServiceBotConfig, ServiceBotNode, ServiceBotOption, Storage } from './storage';
import { WhatsAppTransport } from './types/whatsapp';

export interface ServiceBotValidationResult {
  ok: boolean;
  errors: string[];
}

const BACK_COMMAND = '\u05d7\u05d6\u05e8\u05d4';
const MAIN_MENU_COMMAND = '\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9';

function normalizedText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('he');
}

function normalizedPhone(value: string): string {
  return value.trim().replace(/^whatsapp:/i, '').split('@')[0].replace(/\D/g, '');
}

function normalizedHandoffPhone(value: string | undefined): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `972${digits.slice(1)}`;
  return digits;
}

export function validateServiceBotConfig(value: unknown): ServiceBotValidationResult {
  const errors: string[] = [];
  const candidate = value as Partial<ServiceBotConfig> | null;
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['Service bot config must be an object.'] };
  }
  if (!Array.isArray(candidate.nodes)) {
    return { ok: false, errors: ['nodes must be an array.'] };
  }

  const nodeIds = new Set<string>();
  for (const [index, nodeValue] of candidate.nodes.entries()) {
    const node = nodeValue as Partial<ServiceBotNode>;
    const id = typeof node?.id === 'string' ? node.id.trim() : '';
    if (!id) errors.push(`Node ${index + 1} has an empty id.`);
    else if (nodeIds.has(id)) errors.push(`Duplicate node id: ${id}.`);
    else nodeIds.add(id);
    if (!['menu', 'message', 'handoff'].includes(String(node?.type ?? ''))) {
      errors.push(`Node ${id || index + 1} has an unsupported type.`);
    }
    if (node?.options !== undefined && !Array.isArray(node.options)) {
      errors.push(`Node ${id || index + 1} options must be an array.`);
      continue;
    }
    for (const [optionIndex, optionValue] of (node?.options ?? []).entries()) {
      const option = optionValue as Partial<ServiceBotOption>;
      if (typeof option?.label !== 'string' || !option.label.trim()) {
        errors.push(`Node ${id || index + 1}, option ${optionIndex + 1} has an empty label.`);
      }
    }
  }

  const mainMenuNodeId = typeof candidate.mainMenuNodeId === 'string'
    ? candidate.mainMenuNodeId.trim()
    : '';
  if (!mainMenuNodeId || !nodeIds.has(mainMenuNodeId)) {
    errors.push('The main menu node does not exist.');
  }
  for (const nodeValue of candidate.nodes) {
    const node = nodeValue as Partial<ServiceBotNode>;
    for (const optionValue of node.options ?? []) {
      const option = optionValue as Partial<ServiceBotOption>;
      const target = typeof option.targetNodeId === 'string' ? option.targetNodeId.trim() : '';
      if (!target || !nodeIds.has(target)) {
        errors.push(`Node ${node.id || ''} points to a missing target node: ${target || '(empty)'}.`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function nodeBody(node: ServiceBotNode): string {
  return [node.title.trim(), node.text.trim()].filter(Boolean).join('\n\n');
}

async function sendNode(transport: WhatsAppTransport, to: string, node: ServiceBotNode): Promise<void> {
  let text = nodeBody(node);
  if (node.type === 'handoff') {
    const phone = normalizedHandoffPhone(node.handoffPhone);
    if (phone) text = [text, `https://wa.me/${phone}`].filter(Boolean).join('\n\n');
  }

  const options = node.options ?? [];
  if (!options.length) {
    await transport.sendMessage(to, text);
    return;
  }
  const items = options.map((option) => ({ id: option.id, text: option.label }));
  if (items.length <= 3 && transport.sendInteractiveButtons) {
    await transport.sendInteractiveButtons(to, text, items);
    return;
  }
  if (transport.sendInteractiveList) {
    await transport.sendInteractiveList(to, text, '\u05d1\u05d7\u05d9\u05e8\u05ea \u05d0\u05e4\u05e9\u05e8\u05d5\u05ea', items);
    return;
  }
  await transport.sendMessage(to, `${text}\n\n${items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`);
}

function resolveOption(node: ServiceBotNode, input: string): ServiceBotOption | undefined {
  const options = node.options ?? [];
  const numbered = Number.parseInt(input, 10);
  if (/^\d+$/.test(input) && numbered >= 1 && numbered <= options.length) {
    return options[numbered - 1];
  }
  const normalized = normalizedText(input);
  return options.find((option) =>
    normalizedText(option.id) === normalized || normalizedText(option.label) === normalized);
}

export async function tryHandleServiceBotMessage(
  body: string,
  senderJid: string,
  senderPhone: string,
  storage: Storage,
  transport: WhatsAppTransport,
): Promise<boolean> {
  if (!config.CLIENT_SERVICE_BOT_ENABLED) return false;
  const serviceBot = storage.getServiceBot();
  if (!serviceBot.enabled) return false;
  const validation = validateServiceBotConfig(serviceBot);
  if (!validation.ok) {
    console.warn(`[SERVICE_BOT_INVALID] ${validation.errors.join(' | ')}`);
    return false;
  }

  const phone = normalizedPhone(senderPhone || senderJid);
  const input = normalizedText(body);
  const isTrigger = input === normalizedText(serviceBot.triggerText);
  const isMainMenuCommand = input === normalizedText(MAIN_MENU_COMMAND);
  const isBackCommand = input === normalizedText(BACK_COMMAND);
  const existingSession = storage.getServiceBotSession(phone);
  if (!isTrigger && !existingSession) return false;

  const nodes = new Map(serviceBot.nodes.map((node) => [node.id, node]));
  const mainNode = nodes.get(serviceBot.mainMenuNodeId)!;
  if (isTrigger || isMainMenuCommand || isBackCommand) {
    storage.saveServiceBotSession(phone, mainNode.id);
    await sendNode(transport, senderJid, mainNode);
    return true;
  }

  const currentNode = nodes.get(existingSession!.nodeId) ?? mainNode;
  const option = resolveOption(currentNode, body);
  if (!option) {
    if (serviceBot.fallbackText.trim()) await transport.sendMessage(senderJid, serviceBot.fallbackText.trim());
    storage.saveServiceBotSession(phone, currentNode.id);
    await sendNode(transport, senderJid, currentNode);
    return true;
  }

  const targetNode = nodes.get(option.targetNodeId)!;
  storage.saveServiceBotSession(phone, targetNode.id);
  await sendNode(transport, senderJid, targetNode);
  return true;
}
