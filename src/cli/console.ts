const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const consoleStyles = {
  bold: (text: string) => wrap("1", text),
  dim: (text: string) => wrap("2", text),
  cyan: (text: string) => wrap("36", text),
  blue: (text: string) => wrap("34", text),
  green: (text: string) => wrap("32", text),
  yellow: (text: string) => wrap("33", text),
  red: (text: string) => wrap("31", text),
  magenta: (text: string) => wrap("35", text),
  gray: (text: string) => wrap("90", text),
};

export function sectionTitle(title: string): string {
  return consoleStyles.bold(consoleStyles.cyan(title));
}

export function progressLabel(label: string): string {
  return consoleStyles.bold(consoleStyles.blue(label));
}

export function successLabel(label: string): string {
  return consoleStyles.bold(consoleStyles.green(label));
}

export function warningLabel(label: string): string {
  return consoleStyles.bold(consoleStyles.yellow(label));
}

export function errorLabel(label: string): string {
  return consoleStyles.bold(consoleStyles.red(label));
}

export function severityBadge(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high":
      return consoleStyles.bold(consoleStyles.red("HIGH"));
    case "medium":
      return consoleStyles.bold(consoleStyles.yellow("MEDIUM"));
    case "low":
      return consoleStyles.bold(consoleStyles.green("LOW"));
  }
}
