'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/Icons';
import { isActive } from './nav';

/** Marks the section you are in. Nested routes keep their parent highlighted. */
export default function NavLink({
  href,
  icon,
  children,
  trailing,
  onNavigate,
}: {
  href: string;
  icon?: IconName;
  children: React.ReactNode;
  /** Rendered flush right — the live bulb or a session count. */
  trailing?: React.ReactNode;
  /** Lets the modal drawer close itself when a destination is picked. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  return (
    <Link
      href={href}
      className={active ? 'active' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <span className="nav-label">
        {icon && <Icon name={icon} />}
        <span className="nav-text">{children}</span>
      </span>
      {trailing}
    </Link>
  );
}
