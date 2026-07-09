import { NextResponse, type NextRequest } from 'next/server';

// Presence-only gate for /admin/[venue]/**: real auth is server-side, via
// /admin/me and every API call's requireAuth/requireVenueMatch (Section 6).
// This just avoids flashing the panel before an inevitable 401 redirect.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const match = pathname.match(/^\/admin\/([^/]+)(\/.*)?$/);
  if (!match) return NextResponse.next();

  const [, venue, rest = ''] = match;
  if (rest.startsWith('/login')) return NextResponse.next();

  if (!request.cookies.has('access_token')) {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/${venue}/login`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
