import type { DistroFamily, OutputType, Profile } from "./spec";

/**
 * Packages the builder installs itself. They are not part of the user spec but are recorded in the
 * installed manifest. ISO lists include the kernel and live-boot tooling; container lists stay minimal.
 */
export const BUILDER_BASE_PACKAGES: Record<DistroFamily, Record<OutputType, string[]>> = {
  debian: {
    iso: ["live-config", "live-config-systemd", "systemd-sysv", "sudo", "ca-certificates", "locales", "tzdata"],
    container: ["ca-certificates", "locales", "tzdata"],
  },
  ubuntu: {
    iso: [
      "linux-generic",
      "casper",
      "systemd-sysv",
      "sudo",
      "ca-certificates",
      "locales",
      "tzdata",
      "netplan.io",
      "systemd-resolved",
    ],
    container: ["ca-certificates", "locales", "tzdata"],
  },
};

export const PROFILE_PACKAGES: Record<DistroFamily, Record<Profile, string[]>> = {
  debian: {
    minimal: [],
    xfce: ["xorg", "xfce4", "xfce4-terminal", "lightdm", "network-manager-gnome", "dbus-x11"],
  },
  ubuntu: {
    minimal: [],
    xfce: ["xubuntu-core", "xfce4-terminal", "network-manager-gnome"],
  },
};

export interface PackagePolicyViolation {
  packageName: string;
  reason: string;
}

const RESERVED_PACKAGE_RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^linux-(image|headers|modules|generic|signed|virtual|lowlatency|oem|kbuild)/,
    reason: "Kernel packages are selected by the builder and cannot be changed in v1.",
  },
  {
    pattern: /^(grub|shim|systemd-boot|syslinux|isolinux|efibootmgr)/,
    reason: "Bootloader packages are managed by the builder.",
  },
  {
    pattern: /^(live-boot|live-config|live-build|live-tools|casper|initramfs-tools|dracut)/,
    reason: "Live-boot tooling is managed by the builder.",
  },
  {
    pattern: /^(sysvinit-core|runit-init|openrc|systemd-sysv)$/,
    reason: "Only the builder-managed systemd init is supported.",
  },
];

const UNSUPPORTED_DESKTOP_PACKAGES = new Set([
  "task-gnome-desktop",
  "task-kde-desktop",
  "task-cinnamon-desktop",
  "task-mate-desktop",
  "task-lxde-desktop",
  "task-lxqt-desktop",
  "gnome",
  "gnome-core",
  "kde-plasma-desktop",
  "kde-standard",
  "kde-full",
  "cinnamon-desktop-environment",
  "mate-desktop-environment",
  "mate-desktop-environment-core",
  "mate-desktop-environment-extras",
  "lxde",
  "lxqt",
  "ubuntu-desktop",
  "ubuntu-desktop-minimal",
  "kubuntu-desktop",
  "lubuntu-desktop",
  "ubuntu-mate-desktop",
  "ubuntucinnamon-desktop",
  "ubuntu-budgie-desktop",
  "ubuntustudio-desktop",
]);

/** Packages that the v1 capability set does not allow, regardless of whether they exist in the archive. */
export function findPackagePolicyViolations(packages: readonly string[]): PackagePolicyViolation[] {
  const violations: PackagePolicyViolation[] = [];
  for (const name of packages) {
    if (UNSUPPORTED_DESKTOP_PACKAGES.has(name)) {
      violations.push({
        packageName: name,
        reason: "Only the minimal and XFCE desktop profiles are supported; other desktop environments are not.",
      });
      continue;
    }
    const rule = RESERVED_PACKAGE_RULES.find((r) => r.pattern.test(name));
    if (rule) violations.push({ packageName: name, reason: rule.reason });
  }
  return violations;
}

export const CAPABILITY_SUMMARY = {
  distros: ["Debian 13 (trixie)", "Ubuntu 24.04 LTS (noble)"],
  architectures: ["x86_64"],
  profiles: ["minimal (headless)", "xfce (XFCE desktop with LightDM)"],
  outputs: ["iso (bootable BIOS/UEFI live ISO)", "container (image archive for docker load)"],
  packageSources: ["Debian: main", "Ubuntu: main, universe"],
  notSupported: [
    "disk installers, partitioning or encryption",
    "Secure Boot",
    "ARM or other non-x86_64 architectures",
    "custom scripts, shell hooks, Dockerfiles or arbitrary files",
    "third-party repositories, PPAs, snaps from custom channels, or packages outside the official archive",
    "desktop environments other than XFCE",
    "custom kernels, bootloaders or init systems",
    "publishing to container registries",
  ],
} as const;
