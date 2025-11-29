import chalk from 'chalk';
import qrcode from 'qrcode-terminal';

/**
 * Display a QR code in the terminal for the given URL.
 * Includes input validation and error handling for robust operation.
 */
export function displayQRCode(url: string): void {
  if (!url?.trim()) {
    console.error(chalk.red('✗ Cannot display QR code: invalid URL'));
    return;
  }

  console.log('='.repeat(80));
  console.log('📱 To authenticate, scan this QR code with your mobile device:');
  console.log('='.repeat(80));

  try {
    qrcode.generate(url, { small: true }, (qr) => {
      try {
        if (!qr) {
          console.error(chalk.red('✗ Failed to generate QR code'));
          return;
        }
        for (const line of qr.split('\n')) {
          console.log(' '.repeat(10) + line);
        }
      } catch (callbackError) {
        const errorMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
        console.error(chalk.red('✗ QR code rendering error: ' + errorMessage));
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('✗ QR code generation error: ' + errorMessage));
  }

  console.log('='.repeat(80));
} 