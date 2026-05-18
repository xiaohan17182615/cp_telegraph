export async function printQrToTerminal(qrText: string): Promise<void> {
  try {
    const qr = await import("qrcode-terminal");
    qr.default.generate(qrText, { small: true }, (output) => {
      process.stdout.write(`${output}\n`);
    });
  } catch {
    // The raw login URL/token is still useful when terminal QR rendering fails.
    process.stdout.write(`QR fallback: ${qrText}\n`);
  }
}
