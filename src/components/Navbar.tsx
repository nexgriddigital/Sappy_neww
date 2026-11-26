import React, { useState, useEffect, memo } from 'react';
import {
  LayoutDashboard,
  Store,
  FileText,
  Users,
  Boxes,
  Wallet,
  BarChart3,
  QrCode,
  Settings,
  ShoppingCart,
  LogOut,
  LogIn,
  Database,
  UserCog,
  Search,
  Monitor,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Menu,
  X,
  KeyRound,
  Activity,
  Smartphone,
} from 'lucide-react';
import { AppUser } from '../types/pos.ts';
import { SappyLogo } from './SappyLogo.tsx';
import { PulseSyncIndicator } from './LoadingAnimation.tsx';

export type TabType =
  | 'dashboard'
  | 'register'
  | 'sales'
  | 'activity'
  | 'credit'
  | 'inventory'
  | 'expenses'
  | 'reports'
  | 'qrstudio'
  | 'users'
  | 'settings'
  | 'sync';

interface NavbarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  onPreloadTab?: (tab: TabType) => void;
  cartItemCount: number;
  currentUser: AppUser | null;
  onSignOut: () => void;
  onOpenAuth: () => void;
  syncStatus?: 'synced' | 'syncing' | 'offline' | 'error';
  onManualSync?: () => void;
  onOpenCloudSync?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenCustomerDisplay?: () => void;
  isSoundMuted?: boolean;
  onToggleSound?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onOpenChangeCredentials?: () => void;
}

const NAV_ITEMS: { id: TabType; label: string; shortLabel?: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'register', label: 'POS Register', shortLabel: 'POS Register', icon: Store },
  { id: 'sales', label: 'Sales Ledger', shortLabel: 'Sales Ledger', icon: FileText },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'credit', label: 'Credit & Debt', icon: Users },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'expenses', label: 'Expenses', icon: Wallet },
  { id: 'reports', label: 'General Reports', shortLabel: 'Reports', icon: BarChart3 },
  { id: 'qrstudio', label: 'QR & Barcode', icon: QrCode },
  { id: 'users', label: 'Users & Staff', icon: UserCog },
  { id: 'sync', label: 'Cloud Sync', icon: Database },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const MOBILE_PRIMARY_TABS: { id: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'register', label: 'Register', icon: Store },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'sales', label: 'Sales', icon: FileText },
];

const PRIMARY_MOBILE_TAB_IDS = new Set<TabType>(['register', 'dashboard', 'inventory', 'sales']);

const NavbarComponent: React.FC<NavbarProps> = ({
  activeTab,
  onTabChange,
  onPreloadTab,
  cartItemCount,
  currentUser,
  onSignOut,
  onOpenAuth,
  syncStatus = 'synced',
  onManualSync,
  onOpenCloudSync,
  onOpenCommandPalette,
  onOpenCustomerDisplay,
  isSoundMuted = false,
  onToggleSound,
  isFullscreen = false,
  onToggleFullscreen,
  onOpenChangeCredentials,
}) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileMenuOpen]);

  const handleSelectTab = (tab: TabType) => {
    onTabChange(tab);
    setIsMobileMenuOpen(false);
  };

  const handleWarmTab = (tab: TabType) => {
    if (onPreloadTab) {
      onPreloadTab(tab);
    }
  };

  const isSecondaryTabActive = !PRIMARY_MOBILE_TAB_IDS.has(activeTab);

  return (
    <>
      <header className="no-print bg-charcoal-900 border-b border-charcoal-800 sticky top-0 z-40 shadow-lg">
        {/* ========================================================================= */}
        {/* ROW 1: BRAND LOGO & SYSTEM CONTROLS / UTILITIES */}
        {/* ========================================================================= */}
        <div className="md:border-b border-charcoal-800/80 bg-charcoal-900">
          <div className="max-w-7xl mx-auto px-2.5 sm:px-6 h-12 sm:h-14 flex items-center justify-between gap-2 sm:gap-3">
            
            {/* Left: Brand Identity & Quick Global Search */}
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <button
                type="button"
                onPointerDown={() => handleWarmTab('dashboard')}
                onClick={() => handleSelectTab('dashboard')}
                className="flex items-center gap-2 text-left cursor-pointer shrink-0 active:scale-95 transition-transform touch-manipulation"
                aria-label="SAPPY Dashboard"
              >
                <span className="sm:hidden">
                  <SappyLogo variant="wordmark" size="sm" showSubtitle={false} />
                </span>
                <span className="hidden sm:inline-flex">
                  <SappyLogo variant="wordmark" size="md" showSubtitle={true} />
                </span>
              </button>

              <div className="h-5 w-px bg-charcoal-800 hidden sm:block" />

              {/* Desktop Global Search / Command Palette shortcut */}
              {onOpenCommandPalette && (
                <button
                  type="button"
                  onClick={onOpenCommandPalette}
                  className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-charcoal-950/90 hover:bg-charcoal-800 text-charcoal-400 hover:text-white border border-charcoal-800/90 transition-colors cursor-pointer text-xs group shadow-inner"
                  title="Global Search & Quick Actions (Ctrl+K or /)"
                  aria-label="Open command palette"
                >
                  <Search className="w-3.5 h-3.5 text-forest-400" />
                  <span className="text-[12px] text-charcoal-300 font-sans">Quick search or jump to...</span>
                  <kbd className="ml-1.5 px-1.5 py-0.2 rounded bg-charcoal-900 text-[10px] font-mono text-charcoal-400 border border-charcoal-800">
                    ⌘K
                  </kbd>
                </button>
              )}
            </div>

            {/* Right: Mobile Search, Cloud Sync Status, System Toggles, POS Cart & Menu */}
            <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
              {/* Mobile Quick Search Icon */}
              {onOpenCommandPalette && (
                <button
                  type="button"
                  onClick={onOpenCommandPalette}
                  className="sm:hidden p-1.5 rounded-lg bg-charcoal-950 hover:bg-charcoal-800 text-charcoal-300 border border-charcoal-800 cursor-pointer active:scale-95 touch-manipulation"
                  aria-label="Search catalog and actions"
                >
                  <Search className="w-4 h-4 text-forest-400" />
                </button>
              )}

              {/* Customer Facing Screen Trigger */}
              {onOpenCustomerDisplay && (
                <button
                  type="button"
                  onClick={onOpenCustomerDisplay}
                  className="hidden md:flex p-2 rounded-xl bg-charcoal-950/80 hover:bg-charcoal-800 text-charcoal-400 hover:text-forest-300 border border-charcoal-800 transition-colors cursor-pointer"
                  title="Open Customer Counter Display & Thermal Slip"
                  aria-label="Customer Counter Display"
                >
                  <Monitor className="w-4 h-4" />
                </button>
              )}

              {/* POS Audio Sound Feedback Toggle */}
              {onToggleSound && (
                <button
                  type="button"
                  onClick={onToggleSound}
                  className={`hidden md:flex p-2 rounded-xl border transition-colors cursor-pointer ${
                    isSoundMuted
                      ? 'bg-charcoal-950/80 text-charcoal-500 border-charcoal-800 hover:text-charcoal-300'
                      : 'bg-charcoal-950/80 text-forest-400 border-charcoal-800 hover:bg-charcoal-800'
                  }`}
                  title={isSoundMuted ? 'Sound Muted. Click to enable POS audio feedback' : 'Sound Enabled. Click to mute audio feedback'}
                  aria-label="Toggle POS Sound"
                >
                  {isSoundMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
              )}

              {/* Fullscreen Mode Toggle */}
              {onToggleFullscreen && (
                <button
                  type="button"
                  onClick={onToggleFullscreen}
                  className="hidden lg:flex p-2 rounded-xl bg-charcoal-950/80 hover:bg-charcoal-800 text-charcoal-400 hover:text-white border border-charcoal-800 transition-colors cursor-pointer"
                  title={isFullscreen ? 'Exit Fullscreen POS' : 'Enter Fullscreen Touch POS'}
                  aria-label="Toggle Fullscreen"
                >
                  {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
              )}

              {/* Quick Mobile / Second Device Pairing Trigger */}
              {onOpenCloudSync && (
                <button
                  type="button"
                  onClick={onOpenCloudSync}
                  className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-charcoal-950/80 hover:bg-charcoal-800 text-charcoal-300 hover:text-white border border-charcoal-800 text-xs font-semibold cursor-pointer transition-colors"
                  title="Connect Phone or Another Terminal"
                >
                  <Smartphone className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-[11px] font-mono">Pair Phone</span>
                </button>
              )}

              {/* Live Cross-Device Cloud Sync Indicator */}
              <div className="shrink-0">
                <PulseSyncIndicator
                  status={syncStatus}
                  onClick={onOpenCloudSync || onManualSync}
                />
              </div>

              {/* Quick POS Register Cart Button */}
              <button
                type="button"
                onPointerDown={() => handleWarmTab('register')}
                onClick={() => handleSelectTab('register')}
                className="px-2 py-1.5 sm:px-3 sm:py-2 rounded-lg sm:rounded-xl bg-forest-700 text-white hover:bg-forest-600 transition-colors cursor-pointer flex items-center gap-1.5 active:scale-95 border border-forest-500/80 shadow-sm shrink-0 touch-manipulation"
                aria-label="Open POS Register"
              >
                <ShoppingCart className="w-4 h-4 text-forest-200" />
                <span className="hidden sm:inline text-xs font-bold">POS</span>
                {cartItemCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 bg-amber-400 text-charcoal-950 text-[10px] font-mono font-black rounded-full">
                    {cartItemCount}
                  </span>
                )}
              </button>

              {/* Staff User Profile Badge / Sign Out (Desktop/Tablet) */}
              {currentUser ? (
                <div className="hidden sm:flex items-center gap-1.5 bg-charcoal-950/90 p-1 pl-2 rounded-xl border border-charcoal-800 shrink-0">
                  <button
                    type="button"
                    onPointerDown={() => handleWarmTab('users')}
                    onClick={() => handleSelectTab('users')}
                    className="flex items-center gap-1.5 text-left cursor-pointer group hover:opacity-90"
                    title={`Signed in as ${currentUser.fullName} (${currentUser.role}). Click to manage staff accounts.`}
                  >
                    <div className="w-6 h-6 rounded-lg bg-forest-800 text-forest-200 flex items-center justify-center font-bold text-[11px] font-mono border border-forest-600/50 group-hover:border-forest-400">
                      {currentUser.fullName.charAt(0).toUpperCase()}
                    </div>

                    <div className="hidden xl:block text-left pr-1.5">
                      <p className="text-[11px] font-bold text-white leading-tight truncate max-w-[110px] group-hover:text-forest-300">
                        {currentUser.fullName}
                      </p>
                      <p className="text-[9px] font-mono text-forest-400 uppercase leading-none">
                        {currentUser.role}
                      </p>
                    </div>
                  </button>

                  {onOpenChangeCredentials && (
                    <button
                      type="button"
                      onClick={onOpenChangeCredentials}
                      className="p-1.5 text-charcoal-400 hover:text-amber-400 hover:bg-charcoal-800 rounded-lg transition-colors cursor-pointer"
                      title="Change My Password (PW) & 4-Digit PIN"
                      aria-label="Change Password and PIN"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={onSignOut}
                    className="p-1.5 text-charcoal-400 hover:text-rose-400 hover:bg-charcoal-800 rounded-lg transition-colors cursor-pointer"
                    title={`Signed in as ${currentUser.fullName} (${currentUser.role}). Click to switch user or sign out.`}
                    aria-label="Sign out"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onOpenAuth}
                  className="hidden sm:flex px-3 py-1.5 rounded-xl bg-charcoal-800 hover:bg-charcoal-700 text-charcoal-200 hover:text-white text-xs font-bold transition-colors cursor-pointer items-center gap-1.5 border border-charcoal-700 active:scale-95"
                >
                  <LogIn className="w-3.5 h-3.5 text-forest-400" />
                  <span>Sign In</span>
                </button>
              )}

              {/* Mobile Hamburger Drawer Trigger */}
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(true)}
                className="md:hidden p-1.5 rounded-lg bg-charcoal-950 hover:bg-charcoal-800 text-charcoal-200 hover:text-white border border-charcoal-800 transition-colors cursor-pointer active:scale-95 touch-manipulation"
                aria-label="Open mobile menu"
              >
                <Menu className="w-5 h-5 text-forest-400" />
              </button>
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* ROW 2: DESKTOP & TABLET PRIMARY MODULE NAVIGATION BAR (Hidden on mobile) */}
        {/* ========================================================================= */}
        <div className="hidden md:block bg-charcoal-950">
          <div className="max-w-[1400px] mx-auto px-3 sm:px-4">
            <nav
              aria-label="Primary modules"
              className="flex items-center gap-1 py-1.5 overflow-x-auto no-scrollbar xl:flex-wrap"
            >
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                const isRegister = item.id === 'register';

                return (
                  <button
                    key={item.id}
                    type="button"
                    onPointerDown={() => handleWarmTab(item.id)}
                    onMouseEnter={() => handleWarmTab(item.id)}
                    onClick={() => handleSelectTab(item.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide whitespace-nowrap transition-colors duration-100 cursor-pointer shrink-0 active:scale-95 ${
                      isActive
                        ? 'bg-forest-700 text-white shadow-md shadow-forest-950/70 border border-forest-500/80 font-bold'
                        : 'text-charcoal-400 hover:text-white hover:bg-charcoal-900 border border-transparent hover:border-charcoal-800'
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 ${
                        isActive ? 'text-forest-100' : 'text-charcoal-400'
                      }`}
                    />
                    <span>{item.label}</span>
                    {isRegister && cartItemCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-charcoal-950 font-mono text-[9px] font-black">
                        {cartItemCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* MOBILE BOTTOM NAVIGATION BAR (5 Spacious Thumb-Friendly Tabs) */}
      {/* ========================================================================= */}
      <nav
        aria-label="Mobile bottom navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-charcoal-950 border-t border-charcoal-800 px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] grid grid-cols-5 gap-1 items-center shadow-2xl"
      >
        {MOBILE_PRIMARY_TABS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          const isRegister = item.id === 'register';

          return (
            <button
              key={item.id}
              type="button"
              onPointerDown={() => handleWarmTab(item.id)}
              onClick={() => handleSelectTab(item.id)}
              className={`min-w-0 flex flex-col items-center justify-center py-1 px-1 rounded-xl transition-colors cursor-pointer relative min-h-[48px] active:scale-95 touch-manipulation ${
                isActive
                  ? 'text-forest-400 font-bold bg-charcoal-900 border border-forest-700/50'
                  : 'text-charcoal-400 hover:text-charcoal-200 border border-transparent'
              }`}
            >
              <div className="relative">
                <Icon className={`w-5 h-5 ${isActive ? 'text-forest-400' : 'text-charcoal-400'}`} />
                {isRegister && cartItemCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-charcoal-950 font-mono text-[9px] font-black flex items-center justify-center">
                    {cartItemCount}
                  </span>
                )}
              </div>
              <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full">{item.label}</span>
            </button>
          );
        })}

        {/* 5th Button: More (Opens Fast Drawer) */}
        <button
          type="button"
          onClick={() => setIsMobileMenuOpen(true)}
          className={`min-w-0 flex flex-col items-center justify-center py-1 px-1 rounded-xl transition-colors cursor-pointer relative min-h-[48px] active:scale-95 touch-manipulation ${
            isSecondaryTabActive || isMobileMenuOpen
              ? 'text-amber-400 font-bold bg-charcoal-900 border border-amber-500/40'
              : 'text-charcoal-400 hover:text-charcoal-200 border border-transparent'
          }`}
        >
          <div className="relative">
            <Menu className={`w-5 h-5 ${isSecondaryTabActive || isMobileMenuOpen ? 'text-amber-400' : 'text-charcoal-400'}`} />
            {isSecondaryTabActive && (
              <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-charcoal-950" />
            )}
          </div>
          <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full">More</span>
        </button>
      </nav>

      {/* ========================================================================= */}
      {/* MOBILE SLIDE-OVER NAVIGATION DRAWER (Fast, Zero-Blur, All Modules Grid) */}
      {/* ========================================================================= */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/75"
            onClick={() => setIsMobileMenuOpen(false)}
          />

          {/* Drawer Sheet */}
          <div className="relative ml-auto w-[88vw] max-w-sm bg-charcoal-900 border-l border-charcoal-800 shadow-2xl flex flex-col h-full z-10 overflow-y-auto">
            
            {/* Drawer Top Header */}
            <div className="px-4 py-3 border-b border-charcoal-800 flex items-center justify-between bg-charcoal-950">
              <SappyLogo variant="wordmark" size="sm" showSubtitle={true} />
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="w-9 h-9 rounded-xl bg-charcoal-900 hover:bg-charcoal-800 text-charcoal-300 hover:text-white flex items-center justify-center border border-charcoal-700 cursor-pointer touch-manipulation"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Current Staff User Card in Drawer */}
            <div className="px-4 py-3 bg-charcoal-950/80 border-b border-charcoal-800">
              {currentUser ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-forest-800 border border-forest-600/60 flex items-center justify-center font-bold text-sm text-forest-200 shrink-0">
                      {currentUser.fullName.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-white truncate">
                        {currentUser.fullName}
                      </p>
                      <p className="text-[10px] font-mono text-forest-400 uppercase">
                        {currentUser.role}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onOpenChangeCredentials && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsMobileMenuOpen(false);
                          onOpenChangeCredentials();
                        }}
                        className="p-2 text-amber-400 hover:text-amber-300 bg-charcoal-900 rounded-xl border border-charcoal-700 cursor-pointer touch-manipulation"
                        title="Change Password & PIN"
                        aria-label="Change Password and PIN"
                      >
                        <KeyRound className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        onSignOut();
                      }}
                      className="p-2 text-charcoal-300 hover:text-rose-400 bg-charcoal-900 rounded-xl border border-charcoal-700 cursor-pointer touch-manipulation"
                      title="Sign out / Switch Staff"
                      aria-label="Sign out"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    onOpenAuth();
                  }}
                  className="w-full py-2.5 px-3 bg-forest-700 hover:bg-forest-600 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 cursor-pointer touch-manipulation"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign In to Sappy POS</span>
                </button>
              )}
            </div>

            {/* Drawer Navigation 2-Column Touch Grid */}
            <div className="flex-1 p-3 overflow-y-auto">
              <p className="px-1 pb-2 text-[10px] font-mono font-bold uppercase text-charcoal-500 tracking-wider">
                All Modules
              </p>

              <div className="grid grid-cols-2 gap-2">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onPointerDown={() => handleWarmTab(item.id)}
                      onClick={() => handleSelectTab(item.id)}
                      className={`px-3 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer min-h-[44px] text-left touch-manipulation active:scale-[0.98] ${
                        isActive
                          ? 'bg-forest-700 text-white border border-forest-500 shadow-sm'
                          : 'bg-charcoal-950/70 text-charcoal-200 hover:text-white hover:bg-charcoal-800 border border-charcoal-800'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : 'text-forest-400'}`} />
                      <span className="truncate">{item.shortLabel || item.label}</span>
                      {item.id === 'register' && cartItemCount > 0 && (
                        <span className="ml-auto px-1.5 py-0.2 rounded-full bg-amber-400 text-charcoal-950 font-mono text-[9px] font-black shrink-0">
                          {cartItemCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Mobile Utilities Footer */}
            <div className="p-3 border-t border-charcoal-800 bg-charcoal-950 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="grid grid-cols-2 gap-2">
                {onToggleSound && (
                  <button
                    type="button"
                    onClick={onToggleSound}
                    className={`p-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer touch-manipulation ${
                      isSoundMuted
                        ? 'bg-charcoal-900 text-charcoal-400 border-charcoal-700'
                        : 'bg-charcoal-900 text-forest-300 border-forest-600/60'
                    }`}
                  >
                    {isSoundMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    <span>{isSoundMuted ? 'Muted' : 'Audio On'}</span>
                  </button>
                )}

                {onOpenCustomerDisplay && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      onOpenCustomerDisplay();
                    }}
                    className="p-2.5 rounded-xl bg-charcoal-900 hover:bg-charcoal-800 border border-charcoal-700 text-xs font-semibold text-charcoal-200 flex items-center justify-center gap-1.5 cursor-pointer touch-manipulation"
                  >
                    <Monitor className="w-3.5 h-3.5 text-forest-400" />
                    <span>Customer View</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                {onOpenCloudSync && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      onOpenCloudSync();
                    }}
                    className="p-2.5 bg-charcoal-900 hover:bg-charcoal-800 border border-charcoal-700 rounded-xl text-xs font-semibold text-charcoal-200 flex items-center justify-center gap-1.5 cursor-pointer touch-manipulation"
                  >
                    <Smartphone className="w-3.5 h-3.5 text-amber-400" />
                    <span>Pair / Cloud</span>
                  </button>
                )}

                {onOpenCommandPalette && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      onOpenCommandPalette();
                    }}
                    className="p-2.5 bg-charcoal-900 hover:bg-charcoal-800 border border-charcoal-700 rounded-xl text-xs font-semibold text-charcoal-200 flex items-center justify-center gap-1.5 cursor-pointer touch-manipulation"
                  >
                    <Search className="w-3.5 h-3.5 text-forest-400" />
                    <span>Quick Search</span>
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>
      )}
    </>
  );
};

export const Navbar = memo(NavbarComponent);
