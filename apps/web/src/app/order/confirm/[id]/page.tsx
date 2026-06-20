import { ConfirmClient } from '@/components/confirm/ConfirmClient';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ConfirmPage({ params }: Props) {
  const { id } = await params;
  return <ConfirmClient orderId={id} />;
}
