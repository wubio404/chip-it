import { NextResponse, type NextRequest } from 'next/server';

// Presence-only gate for /admin/[venue]/** and /dashboard/**: real auth (and,
// for /dashboard, the PLATFORM_ADMIN role check) is server-side, via /admin/me
// and every API call's requireAuth/requireRole/requireVenueMatch (Section 6).
// This just avoids flashing the panel before an inevitable redirect.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const adminMatch = pathname.match(/^\/admin\/([^/]+)(\/.*)?$/);
  if (adminMatch) {
    const [, venue, rest = ''] = adminMatch;
    if (rest.startsWith('/login')) return NextResponse.next();

    if (!request.cookies.has('access_token')) {
      const url = request.nextUrl.clone();
      url.pathname = `/admin/${venue}/login`;
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/dashboard') && pathname !== '/dashboard/login') {
    if (!request.cookies.has('access_token')) {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard/login';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/dashboard/:path*'],
};
