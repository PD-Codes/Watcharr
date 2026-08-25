import { redirect } from 'next/navigation';
import { isConfigured } from '@/server/config';
import SetupForm from './SetupForm';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (await isConfigured()) redirect('/login');
  return <SetupForm />;
}
