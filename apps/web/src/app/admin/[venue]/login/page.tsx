import { LoginForm } from '@/components/admin/LoginForm';

interface Props {
  params: Promise<{ venue: string }>;
}

export default async function AdminLoginPage({ params }: Props) {
  const { venue } = await params;
  return <LoginForm venueSlug={venue} />;
}
