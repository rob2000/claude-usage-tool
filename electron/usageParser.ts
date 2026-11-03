export interface ParsedUsageBar {
  value: number;
  max: number;
  label: string;
  resetInfo: string;
  percentage: number;
}

// This function is also injected into the usage page, so keep it self-contained.
export function parseUsageBars(text: string): ParsedUsageBar[] {
  const sectionLabels = [
    'Current session', 'All models', 'Sonnet only', 'Extra usage',
    'Weekly limit', 'Weekly limits', 'Daily limit', 'Monthly limit',
    'Standard', 'Advanced',
    'Aktuelle Sitzung', 'Aktuelle Session', 'Alle Modelle', 'Nur Sonnet',
    'Sonnet nur', 'Zusätzliche Nutzung', 'Wöchentliches Limit',
    'Wöchentliche Limits', 'Tägliches Limit', 'Monatliches Limit',
  ];
  const headers = ['weekly limit', 'weekly limits', 'wöchentliches limit', 'wöchentliche limits'];
  const isSectionLabel = (line: string) => sectionLabels.some(
    label => line.toLowerCase() === label.toLowerCase()
  );
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const bars: ParsedUsageBar[] = [];
  let foundSection = false;

  for (let i = 0; i < lines.length; i++) {
    const label = lines[i];
    if (!isSectionLabel(label)) continue;
    foundSection = true;
    if (headers.includes(label.toLowerCase())) continue;

    let percentage: number | null = null;
    let resetInfo = '';

    // Warnings can add any number of lines inside a section. Stop at the next
    // heading rather than borrowing another section's percentage or reset time.
    for (let j = i + 1; j < lines.length && !isSectionLabel(lines[j]); j++) {
      const line = lines[j];
      const lowered = line.toLowerCase();
      if (lowered.startsWith('reset') || lowered.startsWith('zurücksetzung') ||
          (lowered.startsWith('wird ') && lowered.endsWith('zurückgesetzt'))) {
        resetInfo = line;
      }

      const match = line.match(/(\d+)\s*%\s*(used|verbraucht|genutzt|verwendet)/i);
      if (match && percentage === null) percentage = Number(match[1]);
    }

    // Zero is valid usage; a missing percentage must not be reported as zero.
    if (percentage !== null) {
      bars.push({ value: percentage, max: 100, label, resetInfo, percentage });
    }
  }

  // Only infer labels when the page has no recognised sections at all.
  // Otherwise a missing session could be replaced with a weekly percentage.
  if (!foundSection) {
    const defaultLabels = ['Current Session', 'All models', 'Sonnet only', 'Extra usage'];
    for (const match of text.matchAll(/(\d+)\s*%\s*(used|verbraucht|genutzt|verwendet)/gi)) {
      const percentage = Number(match[1]);
      if (percentage > 100) continue;
      const index = match.index || 0;
      const context = text.substring(Math.max(0, index - 100), index + 100);
      const reset = context.match(/Resets?[^\n]*/i);
      bars.push({
        value: percentage,
        max: 100,
        label: defaultLabels[bars.length] || `Usage ${bars.length + 1}`,
        resetInfo: reset ? reset[0].trim() : '',
        percentage,
      });
    }
  }

  return bars;
}
