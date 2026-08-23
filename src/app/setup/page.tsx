import { redirect } from 'next/navigation';
import { getConfig } from '@/server/config';
import SetupForm from './SetupForm';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (await getConfig()) redirect('/login');
  return <SetupForm />;
}
