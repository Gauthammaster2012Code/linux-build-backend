import { resolveSpecDefaults } from "@linxgen/spec";
import type { ToolchainLock } from "../src/config";

export const LOCK: ToolchainLock = {
  images: {
    "debian-13": `docker.io/library/debian:trixie@sha256:${"a".repeat(64)}`,
    "ubuntu-24.04": `docker.io/library/ubuntu:24.04@sha256:${"b".repeat(64)}`,
  },
  mirrors: {
    debian: "http://deb.debian.org/debian",
    debianSecurity: "http://security.debian.org/debian-security",
    ubuntu: "http://archive.ubuntu.com/ubuntu",
    ubuntuSecurity: "http://security.ubuntu.com/ubuntu",
  },
};

export const SPEC = resolveSpecDefaults({
  schemaVersion: 1,
  name: "Dev box",
  distro: { family: "ubuntu", release: "24.04" },
  architecture: "x86_64",
  profile: "xfce",
  packages: ["git", "curl", "ca-certificates"],
  outputs: ["container", "iso"],
});
