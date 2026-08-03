import React from "react";
import WithAuth from "@/components/WithAuth";
import BackButton from "@/components/BackButton";

export default function AuthRequiredLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Outside WithAuth so the up-affordance is present even on the auth
          screen — a user who lands here by accident can get back to the root. */}
      <BackButton />
      <WithAuth>{children}</WithAuth>
    </>
  );
}