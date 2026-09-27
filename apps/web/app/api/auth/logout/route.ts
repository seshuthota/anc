import { NextResponse } from "next/server";
import { SESSION_COOKIE, cookieOptions } from "../../../../lib/server-auth";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return response;
}
