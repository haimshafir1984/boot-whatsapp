import { config } from './config';
import {
  ServiceBotCondition,
  ServiceBotConfig,
  ServiceBotFollowUp,
  ServiceBotNode,
  ServiceBotOption,
  Storage,
} from './storage';
import { WhatsAppTransport } from './types/whatsapp';

export interface ServiceBotValidationResult {
  ok: boolean;
  errors: string[];
}

const BACK_COMMAND = '\u05d7\u05d6\u05e8\u05d4';
const MAIN_MENU_COMMAND = '\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9';
const RESTART_COMMAND = '\u05d4\u05ea\u05d7\u05dc\u05d4 \u05de\u05d7\u05d3\u05e9';
const BACK_OPTION_ID = '__service_back__';
const MAIN_OPTION_ID = '__service_main__';
const HANDOFF_OPTION_ID = '__service_handoff__';

export interface ServiceBotInboundContext {
  messageId?: string;
  media?: {
    kind: string;
    mimeType?: string;
    fileName?: string;
    providerMediaId?: string;
    providerUrl?: string;
  };
}

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
  if (candidate.sessionTimeoutMinutes !== undefined && (!Number.isFinite(Number(candidate.sessionTimeoutMinutes)) || Number(candidate.sessionTimeoutMinutes) < 1 || Number(candidate.sessionTimeoutMinutes) > 10080)) {
    errors.push('sessionTimeoutMinutes must be between 1 and 10080.');
  }

  const nodeIds = new Set<string>();
  for (const [index, nodeValue] of candidate.nodes.entries()) {
    const node = nodeValue as Partial<ServiceBotNode>;
    const id = typeof node?.id === 'string' ? node.id.trim() : '';
    if (!id) errors.push(`Node ${index + 1} has an empty id.`);
    else if (nodeIds.has(id)) errors.push(`Duplicate node id: ${id}.`);
    else nodeIds.add(id);
    if (!['menu', 'message', 'handoff', 'input', 'condition'].includes(String(node?.type ?? ''))) {
      errors.push(`Node ${id || index + 1} has an unsupported type.`);
    }
    if (node?.followUpDelayMinutes !== undefined && (!Number.isFinite(Number(node.followUpDelayMinutes)) || Number(node.followUpDelayMinutes) < 1 || Number(node.followUpDelayMinutes) > 10080)) {
      errors.push(`Node ${id || index + 1} follow-up delay must be between 1 and 10080 minutes.`);
    }
    if (node?.type === 'input') {
      if (!['text', 'number', 'image', 'document', 'media'].includes(String(node.inputType ?? ''))) {
        errors.push(`Input node ${id || index + 1} has an unsupported input type.`);
      }
      if (!String(node.variableKey ?? '').trim()) errors.push(`Input node ${id || index + 1} must define a variable key.`);
      if (!String(node.nextNodeId ?? '').trim()) errors.push(`Input node ${id || index + 1} must define a next node.`);
    }
    if (node?.type === 'condition') {
      if (!Array.isArray(node.conditionRules) || !node.conditionRules.length) {
        errors.push(`Condition node ${id || index + 1} must define at least one rule.`);
      }
      for (const [ruleIndex, rule] of (node.conditionRules ?? []).entries()) {
        if (!Array.isArray(rule.conditions) || !rule.conditions.length) errors.push(`Condition node ${id || index + 1}, rule ${ruleIndex + 1} has no conditions.`);
        if (!String(rule.targetNodeId ?? '').trim()) errors.push(`Condition node ${id || index + 1}, rule ${ruleIndex + 1} has no target.`);
        for (const condition of rule.conditions ?? []) {
          if (!String(condition.variableKey ?? '').trim()) errors.push(`Condition node ${id || index + 1}, rule ${ruleIndex + 1} has an empty variable key.`);
          if (!['equals', 'not_equals', 'contains', 'exists'].includes(String(condition.operator ?? ''))) errors.push(`Condition node ${id || index + 1}, rule ${ruleIndex + 1} has an unsupported operator.`);
        }
      }
      if (!String(node.defaultTargetNodeId ?? '').trim()) errors.push(`Condition node ${id || index + 1} must define a default target.`);
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
    const referencedTargets = [node.nextNodeId, node.defaultTargetNodeId, node.followUpTargetNodeId, ...(node.conditionRules ?? []).map((rule) => rule.targetNodeId)]
      .map((target) => String(target ?? '').trim())
      .filter(Boolean);
    for (const target of referencedTargets) {
      if (!nodeIds.has(target)) errors.push(`Node ${node.id || ''} points to a missing target node: ${target}.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function renderTemplate(value: unknown, variables: Record<string, string>): string {
  return String(value ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? '');
}

function nodeBody(node: ServiceBotNode, variables: Record<string, string>): string {
  return [renderTemplate(node.title, variables).trim(), renderTemplate(node.text, variables).trim()].filter(Boolean).join('\n\n');
}

async function sendNode(transport: WhatsAppTransport, to: string, node: ServiceBotNode, variables: Record<string, string>): Promise<void> {
  let text = nodeBody(node, variables);
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

function conditionMatches(condition: ServiceBotCondition, variables: Record<string, string>): boolean {
  const actual = normalizedText(variables[condition.variableKey] ?? '');
  const expected = normalizedText(condition.value ?? '');
  if (condition.operator === 'exists') return Boolean(actual);
  if (condition.operator === 'not_equals') return actual !== expected;
  if (condition.operator === 'contains') return actual.includes(expected);
  return actual === expected;
}

function resolveConditionTarget(node: ServiceBotNode, variables: Record<string, string>): string {
  const matching = (node.conditionRules ?? []).find((rule) =>
    (rule.conditions ?? []).length > 0 && rule.conditions.every((condition) => conditionMatches(condition, variables)));
  return matching?.targetNodeId || node.defaultTargetNodeId || '';
}

function scheduleNodeFollowUp(
  storage: Storage,
  to: string,
  phone: string,
  node: ServiceBotNode,
  variables: Record<string, string>,
): void {
  const delay = Number(node.followUpDelayMinutes || 0);
  const text = renderTemplate(node.followUpText, variables).trim();
  const targetNodeId = String(node.followUpTargetNodeId || '').trim();
  if (!Number.isFinite(delay) || delay < 1 || (!text && !targetNodeId)) return;
  storage.cancelServiceBotFollowUps(phone);
  storage.scheduleServiceBotFollowUp({
    phone,
    to,
    nodeId: node.id,
    targetNodeId: targetNodeId || undefined,
    text: text || undefined,
    runAt: new Date(Date.now() + delay * 60 * 1000).toISOString(),
  });
}

async function enterNode(
  storage: Storage,
  transport: WhatsAppTransport,
  to: string,
  phone: string,
  serviceBot: ServiceBotConfig,
  nodeId: string,
  path: string[],
  variables: Record<string, string>,
  depth = 0,
): Promise<boolean> {
  if (depth > 20) throw new Error('Service bot automatic transition limit exceeded.');
  const node = serviceBot.nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  if (node.type === 'condition') {
    const target = resolveConditionTarget(node, variables);
    if (!target) return false;
    return await enterNode(storage, transport, to, phone, serviceBot, target, path, variables, depth + 1);
  }
  storage.saveServiceBotSession(phone, node.id, path, variables);
  storage.recordServiceBotProgress(phone, node.id, variables);
  await sendNode(transport, to, node, variables);
  scheduleNodeFollowUp(storage, to, phone, node, variables);
  return true;
}

async function sendNavigation(
  transport: WhatsAppTransport,
  to: string,
  serviceBot: ServiceBotConfig,
  currentNode: ServiceBotNode,
  path: string[],
  mainNodeId: string,
): Promise<void> {
  if (currentNode.id === mainNodeId) return;
  const backLabel = String(serviceBot.backLabel || '\u05d7\u05d6\u05e8\u05d4 \u05dc\u05ea\u05e4\u05e8\u05d9\u05d8 \u05d4\u05e7\u05d5\u05d3\u05dd');
  const mainMenuLabel = String(serviceBot.mainMenuLabel || '\u05d7\u05d6\u05e8\u05d4 \u05dc\u05ea\u05e4\u05e8\u05d9\u05d8 \u05d4\u05e8\u05d0\u05e9\u05d9');
  const buttons = path.length && path[path.length - 1] !== mainNodeId
    ? [{ id: BACK_OPTION_ID, text: backLabel }, { id: MAIN_OPTION_ID, text: mainMenuLabel }]
    : [{ id: MAIN_OPTION_ID, text: mainMenuLabel }];
  if (serviceBot.globalHandoffEnabled && String(serviceBot.globalHandoffPhone || '').replace(/\D/g, '')) {
    buttons.push({ id: HANDOFF_OPTION_ID, text: String(serviceBot.globalHandoffLabel || '\u05e9\u05d9\u05d7\u05d4 \u05e2\u05dd \u05e0\u05e6\u05d9\u05d2') });
  }
  const prompt = String(serviceBot.navigationPromptText ?? '\u05de\u05d4 \u05ea\u05e8\u05e6\u05d5 \u05dc\u05e2\u05e9\u05d5\u05ea \u05e2\u05db\u05e9\u05d9\u05d5?').trim();
  if (!prompt) return;
  if (buttons.length <= 3 && transport.sendInteractiveButtons) {
    await transport.sendInteractiveButtons(to, prompt, buttons);
  } else if (transport.sendInteractiveList) {
    await transport.sendInteractiveList(to, prompt, '\u05d1\u05d7\u05d9\u05e8\u05d4', buttons);
  } else {
    await transport.sendMessage(to, `${prompt}\n\n${buttons.map((button, index) => `${index + 1}. ${button.text}`).join('\n')}`);
  }
}

function outsideBusinessHours(serviceBot: ServiceBotConfig): boolean {
  if (!serviceBot.outsideHoursEnabled || !String(serviceBot.outsideHoursText || '').trim()) return false;
  const toMinutes = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : null;
  };
  const start = toMinutes(String(serviceBot.outsideHoursStart || '09:00'));
  const end = toMinutes(String(serviceBot.outsideHoursEnd || '17:00'));
  if (start === null || end === null || start === end) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  return !inside;
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
  inbound: ServiceBotInboundContext = {},
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
  const isRestartCommand = input === normalizedText(RESTART_COMMAND);
  const existingSession = storage.getServiceBotSession(phone);
  if (!isTrigger && !isMainMenuCommand && !isRestartCommand && !existingSession) return false;

  storage.cancelServiceBotFollowUps(phone);

  const nodes = new Map(serviceBot.nodes.map((node) => [node.id, node]));
  const mainNode = nodes.get(serviceBot.mainMenuNodeId)!;
  if (isTrigger || isMainMenuCommand || isRestartCommand) {
    if (isTrigger && outsideBusinessHours(serviceBot)) {
      await transport.sendMessage(senderJid, String(serviceBot.outsideHoursText || '').trim());
      return true;
    }
    return await enterNode(storage, transport, senderJid, phone, serviceBot, mainNode.id, [], {});
  }

  const currentNode = nodes.get(existingSession!.nodeId) ?? mainNode;
  const path = [...(existingSession!.path ?? [])];
  const variables = { ...(existingSession!.variables ?? {}) };
  const normalizedInput = normalizedText(body);
  if (normalizedInput === normalizedText(BACK_COMMAND) || normalizedInput === normalizedText(serviceBot.backLabel || 'חזרה לתפריט הקודם')) {
    const previousId = path[path.length - 1] ?? mainNode.id;
    const nextPath = path.length ? path.slice(0, -1) : [];
    const previousNode = nodes.get(previousId) ?? mainNode;
    storage.saveServiceBotSession(phone, previousNode.id, nextPath, variables);
    await sendNode(transport, senderJid, previousNode, variables);
    await sendNavigation(transport, senderJid, serviceBot, previousNode, nextPath, mainNode.id);
    return true;
  }
  if (normalizedInput === normalizedText(MAIN_MENU_COMMAND) || normalizedInput === normalizedText(serviceBot.mainMenuLabel || 'חזרה לתפריט הראשי')) {
    return await enterNode(storage, transport, senderJid, phone, serviceBot, mainNode.id, [], variables);
  }
  const navigationOption = normalizedInput === normalizedText(BACK_OPTION_ID)
    ? BACK_OPTION_ID
    : normalizedInput === normalizedText(MAIN_OPTION_ID) ? MAIN_OPTION_ID : '';
  if (navigationOption === BACK_OPTION_ID || navigationOption === MAIN_OPTION_ID) {
    const target = navigationOption === MAIN_OPTION_ID ? mainNode : nodes.get(path[path.length - 1]) ?? mainNode;
    const nextPath = navigationOption === MAIN_OPTION_ID ? [] : path.slice(0, -1);
    storage.saveServiceBotSession(phone, target.id, nextPath, variables);
    await sendNode(transport, senderJid, target, variables);
    await sendNavigation(transport, senderJid, serviceBot, target, nextPath, mainNode.id);
    return true;
  }
  if (normalizedInput === normalizedText(HANDOFF_OPTION_ID)) {
    const phone = normalizedHandoffPhone(serviceBot.globalHandoffPhone);
    if (phone) await transport.sendMessage(senderJid, [String(serviceBot.globalHandoffText || '').trim(), `https://wa.me/${phone}`].filter(Boolean).join('\n\n'));
    return true;
  }

  if (currentNode.type === 'input') {
    const variableKey = String(currentNode.variableKey || '').trim();
    const inputType = currentNode.inputType || 'text';
    const media = inbound.media;
    let captured = '';
    let valid = false;
    if (inputType === 'number') {
      valid = /^[-+]?\d+(?:[.,]\d+)?$/.test(String(body || '').trim());
      captured = String(body || '').trim().replace(',', '.');
    } else if (inputType === 'image') {
      valid = media?.kind === 'image';
      captured = valid ? '[image]' : '';
    } else if (inputType === 'document') {
      valid = media?.kind === 'document';
      captured = valid ? '[document]' : '';
    } else if (inputType === 'media') {
      valid = Boolean(media);
      captured = valid ? `[${media!.kind}]` : '';
    } else {
      valid = Boolean(String(body || '').trim());
      captured = String(body || '').trim();
    }
    if (!valid || !variableKey) {
      await transport.sendMessage(senderJid, String(currentNode.inputErrorText || serviceBot.fallbackText).trim());
      await sendNode(transport, senderJid, currentNode, variables);
      return true;
    }
    variables[variableKey] = captured;
    storage.saveServiceBotSession(phone, currentNode.id, path, variables);
    storage.recordServiceBotProgress(phone, currentNode.id, variables, media ? {
      messageId: inbound.messageId || `${phone}:${Date.now()}`,
      variableKey,
      kind: media.kind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      providerMediaId: media.providerMediaId,
      providerUrl: media.providerUrl,
    } : undefined);
    const target = String(currentNode.nextNodeId || '').trim();
    if (!target) return true;
    const nextPath = [...path, currentNode.id].slice(-12);
    const entered = await enterNode(storage, transport, senderJid, phone, serviceBot, target, nextPath, variables);
    const enteredSession = storage.getServiceBotSession(phone);
    const enteredNode = enteredSession ? nodes.get(enteredSession.nodeId) : undefined;
    if (enteredNode && enteredNode.type !== 'input') await sendNavigation(transport, senderJid, serviceBot, enteredNode, enteredSession?.path ?? nextPath, mainNode.id);
    return entered;
  }
  const option = resolveOption(currentNode, body);
  if (!option) {
    if (serviceBot.fallbackText.trim()) await transport.sendMessage(senderJid, serviceBot.fallbackText.trim());
    storage.saveServiceBotSession(phone, currentNode.id, path, variables);
    await sendNode(transport, senderJid, currentNode, variables);
    await sendNavigation(transport, senderJid, serviceBot, currentNode, path, mainNode.id);
    return true;
  }

  const targetNode = nodes.get(option.targetNodeId)!;
  if (String(option.variableKey || '').trim()) {
    variables[String(option.variableKey).trim()] = String(option.variableValue ?? option.label).trim();
  }
  const nextPath = targetNode.id === mainNode.id
    ? []
    : [...path, currentNode.id].slice(-12);
  await enterNode(storage, transport, senderJid, phone, serviceBot, targetNode.id, nextPath, variables);
  const enteredSession = storage.getServiceBotSession(phone);
  const enteredNode = enteredSession ? nodes.get(enteredSession.nodeId) : targetNode;
  if (enteredNode && enteredNode.type !== 'input') await sendNavigation(transport, senderJid, serviceBot, enteredNode, enteredSession?.path ?? nextPath, mainNode.id);
  return true;
}

export async function deliverServiceBotFollowUp(
  followUp: ServiceBotFollowUp,
  storage: Storage,
  transport: WhatsAppTransport,
): Promise<void> {
  const serviceBot = storage.getServiceBot();
  if (!config.CLIENT_SERVICE_BOT_ENABLED || !serviceBot.enabled || !validateServiceBotConfig(serviceBot).ok) return;
  const session = storage.getServiceBotSession(followUp.phone);
  if (!session || session.nodeId !== followUp.nodeId) return;
  const variables = { ...(session.variables ?? {}) };
  if (followUp.targetNodeId) {
    await enterNode(storage, transport, followUp.to, followUp.phone, serviceBot, followUp.targetNodeId, [...(session.path ?? []), session.nodeId].slice(-12), variables);
    const nextSession = storage.getServiceBotSession(followUp.phone);
    const node = serviceBot.nodes.find((item) => item.id === nextSession?.nodeId);
    if (node && node.type !== 'input') await sendNavigation(transport, followUp.to, serviceBot, node, nextSession?.path ?? [], serviceBot.mainMenuNodeId);
    return;
  }
  const text = renderTemplate(followUp.text, variables).trim();
  if (text) await transport.sendMessage(followUp.to, text);
}
