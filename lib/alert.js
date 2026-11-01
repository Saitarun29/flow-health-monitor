// Flow Health Monitor: alert text, same format as the n8n "Compute Health" Code node.
// Pure function, shared by the browser preview.

const ICON = { SILENT: '🔕', FAILING: '🔴', SLOW: '🐢', OK: '✅' };

export function alertText({ channel = 'slack', status = 'OK', recovered = false, name = '', client = '', reason = '', lastSuccess = 'never', streak = 0, url = '' } = {}) {
  const icon = recovered ? ICON.OK : (ICON[status] || ICON.OK);
  const title = recovered ? 'RECOVERED' : status;
  const lines = [
    `${icon} *${title}* · *${name}*`,
    `Client: ${client}`,
    `> ${reason}`,
    `Last success: ${lastSuccess} · Fail streak: ${streak}`,
  ];
  if (url) lines.push(channel === 'telegram' ? `Open workflow in n8n: ${url}` : `<${url}|Open workflow in n8n>`);
  return lines.join('\n');
}
