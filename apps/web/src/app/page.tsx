import { redirect } from 'next/navigation';

// Root → redirect to /order so the bare domain shows the scan-prompt error
// rather than a blank 404. Customers always arrive via the NFC/QR URL directly.
export default function Home() {
  redirect('/order');
}
