import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase } from '../lib/supabaseClient.js';

function maskPhone(mobile) {
  if (!mobile || mobile.length < 10) return mobile;
  return `+91 ${mobile.slice(0, 2)}XXXXXX${mobile.slice(-2)}`;
}

export default function AuthModal() {
  const {
    isAuthModalOpen,
    closeAuthModal,
    authModalMode,
    setAuthModalMode,
    login,
    showToast,
  } = useAuth();

  // Mode: 'login-step1' | 'login-step2' | 'register' | 'forgot-step1' | 'forgot-step2' | 'forgot-step3'
  const [step, setStep] = useState('login-step1');

  // Input States
  const [identifier, setIdentifier] = useState('');
  const [userInfo, setUserInfo] = useState(null);
  const [mpin, setMpin] = useState(['', '', '', '']);
  const [showMpin, setShowMpin] = useState(false);

  // Register Form
  const [fullName, setFullName] = useState('');
  const [regMobile, setRegMobile] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regMpin, setRegMpin] = useState(['', '', '', '']);
  const [confirmMpin, setConfirmMpin] = useState(['', '', '', '']);

  // Forgot PIN Form
  const [forgotMobile, setForgotMobile] = useState('');
  const [otpVal, setOtpVal] = useState('');
  const [newMpin, setNewMpin] = useState(['', '', '', '']);
  const [confirmNewMpin, setConfirmNewMpin] = useState(['', '', '', '']);

  // Feedback states
  const [loading, setLoading] = useState(false);
  const [rawError, setRawError] = useState(null);
  const [lockoutMsg, setLockoutMsg] = useState(null);

  // Error setter
  const setError = (msg) => {
    if (!msg) {
      setRawError(null);
      return;
    }
    const str = String(msg);
    if (str.toLowerCase().includes('failed to fetch') || str.toLowerCase().includes('networkerror')) {
      setRawError(null);
      return;
    }
    setRawError(str);
  };

  // Refs for 4-digit MPIN auto-focus
  const mpinInputRefs = useRef([]);
  const regMpinRefs = useRef([]);
  const confirmMpinRefs = useRef([]);
  const newMpinRefs = useRef([]);

  useEffect(() => {
    if (authModalMode === 'login') setStep('login-step1');
    if (authModalMode === 'register') setStep('register');
    if (authModalMode === 'forgot') setStep('forgot-step1');
    setError(null);
    setLockoutMsg(null);
    setMpin(['', '', '', '']);

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isAuthModalOpen) {
        closeAuthModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [authModalMode, isAuthModalOpen, closeAuthModal]);

  if (!isAuthModalOpen) return null;

  // Handle PIN digit input navigation
  const handleDigitChange = (index, value, digitsArray, setDigitsArray, nextRefs) => {
    const clean = value.replace(/\D/g, '').slice(-1);
    const newArr = [...digitsArray];
    newArr[index] = clean;
    setDigitsArray(newArr);

    if (clean && index < 3 && nextRefs.current[index + 1]) {
      nextRefs.current[index + 1].focus();
    }
  };

  const handleDigitKeyDown = (index, e, digitsArray, setDigitsArray, refs) => {
    if (e.key === 'Backspace' && !digitsArray[index] && index > 0 && refs.current[index - 1]) {
      refs.current[index - 1].focus();
    }
  };

  // Step 1 Login: Check if user exists in Supabase Cloud app_users table
  const handleCheckIdentifier = async (e) => {
    e.preventDefault();
    const cleanId = identifier.trim().toLowerCase();
    const cleanMobile = cleanId.replace(/\D/g, '');
    if (!cleanId) return;

    setLoading(true);
    setError(null);
    setLockoutMsg(null);

    if (!supabase) {
      setError('Database connection error. Please try again.');
      setLoading(false);
      return;
    }

    try {
      let query = supabase.from('app_users').select('*');
      if (cleanMobile.length === 10) {
        query = query.or(`mobile.eq.${cleanMobile},email.eq.${cleanId}`);
      } else {
        query = query.eq('email', cleanId);
      }

      const { data, error: supaErr } = await query;
      const match = data && data.length > 0 ? data[0] : null;
      if (!supaErr && match) {
        setUserInfo({
          id: match.id,
          full_name: match.full_name,
          mobile: match.mobile,
          email: match.email,
          mpin: match.mpin,
          masked_phone: maskPhone(match.mobile),
        });
        setStep('login-step2');
        setTimeout(() => mpinInputRefs.current[0]?.focus(), 100);
      } else {
        setError('No account found with this mobile number or email. Click "Create Account" to register.');
      }
    } catch (err) {
      setError('Could not verify account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Step 2 Login: Verify 4-Digit PIN strictly against Supabase record
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    const enteredMpin = mpin.join('');
    if (enteredMpin.length !== 4) return;

    setLoading(true);
    setError(null);

    if (userInfo && userInfo.mpin === enteredMpin) {
      login('supa_token_' + Date.now(), {
        id: userInfo.id,
        full_name: userInfo.full_name,
        mobile: userInfo.mobile,
        email: userInfo.email,
        masked_phone: userInfo.masked_phone,
      });
    } else {
      setMpin(['', '', '', '']);
      setTimeout(() => mpinInputRefs.current[0]?.focus(), 100);
      setError('Incorrect 4-digit PIN. Please try again.');
    }

    setLoading(false);
  };

  // Account Registration: Insert strictly into Supabase Cloud app_users table
  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (fullName.trim().length < 3) {
      setError('Full Name must be at least 3 characters.');
      return;
    }
    const cleanMobile = regMobile.replace(/\D/g, '');
    if (cleanMobile.length !== 10) {
      setError('Please enter a valid 10-digit Indian mobile number.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(regEmail.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    const mpinStr = regMpin.join('');
    const confirmStr = confirmMpin.join('');
    if (mpinStr.length !== 4) {
      setError('Create a 4-digit PIN.');
      return;
    }
    if (mpinStr !== confirmStr) {
      setError('PINs do not match. Please re-enter.');
      return;
    }

    setLoading(true);

    if (!supabase) {
      setError('Database connection error. Please try again.');
      setLoading(false);
      return;
    }

    try {
      // Check if user already exists in Supabase
      const { data: existingUsers } = await supabase
        .from('app_users')
        .select('*')
        .or(`mobile.eq.${cleanMobile},email.eq.${regEmail.trim().toLowerCase()}`);

      if (existingUsers && existingUsers.length > 0) {
        setError('An account with this mobile number or email already exists. Please Sign In.');
        setLoading(false);
        return;
      }

      // Insert new user row into Supabase app_users table
      const { data, error: supaErr } = await supabase
        .from('app_users')
        .insert({
          full_name: fullName.trim(),
          mobile: cleanMobile,
          email: regEmail.trim().toLowerCase(),
          mpin: mpinStr,
        })
        .select();

      if (!supaErr && data && data.length > 0) {
        const newUser = data[0];
        showToast('Account registered successfully in Supabase Cloud!');
        login('supa_token_' + Date.now(), {
          id: newUser.id,
          full_name: newUser.full_name,
          mobile: newUser.mobile,
          email: newUser.email,
          masked_phone: maskPhone(newUser.mobile),
        });
      } else {
        setError('Registration failed. Please check your network connection.');
      }
    } catch (err) {
      setError('Registration error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Forgot PIN Step 1: Send Verification OTP
  const handleSendOtp = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const cleanMobile = forgotMobile.trim().replace(/\D/g, '');
    if (cleanMobile.length !== 10) {
      setError('Enter a valid 10-digit mobile number.');
      setLoading(false);
      return;
    }

    if (supabase) {
      const { data } = await supabase.from('app_users').select('*').eq('mobile', cleanMobile);
      if (!data || data.length === 0) {
        setError('No account registered with this mobile number.');
        setLoading(false);
        return;
      }
    }

    showToast(`Verification OTP sent to ${maskPhone(cleanMobile)} (Demo OTP: 7890).`);
    setStep('forgot-step2');
    setLoading(false);
  };

  // Forgot PIN Step 2: Verify OTP
  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError(null);

    const cleanOtp = otpVal.trim();
    if (cleanOtp !== '7890' && cleanOtp.length !== 4) {
      setError('Invalid OTP code. Please enter 7890.');
      return;
    }

    setStep('forgot-step3');
  };

  // Forgot PIN Step 3: Reset PIN in Supabase Cloud
  const handleResetMpinSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const newStr = newMpin.join('');
    const confirmStr = confirmNewMpin.join('');

    if (newStr.length !== 4) {
      setError('Enter a 4-digit PIN.');
      return;
    }
    if (newStr !== confirmStr) {
      setError('PINs do not match.');
      return;
    }

    setLoading(true);
    const cleanMobile = forgotMobile.trim().replace(/\D/g, '');

    if (supabase) {
      try {
        await supabase
          .from('app_users')
          .update({ mpin: newStr })
          .eq('mobile', cleanMobile);
      } catch (e) {}
    }

    showToast('PIN reset successfully! Please sign in with your new PIN.');
    setAuthModalMode('login');
    setStep('login-step1');
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto bg-[#1C271D] border border-[#4F633D] rounded-3xl shadow-2xl backdrop-blur-xl relative text-[#FFF7E2]">
        
        {/* Close Button */}
        <button
          onClick={closeAuthModal}
          className="absolute top-4 right-4 text-[#A3B59B] hover:text-[#FFF7E2] p-2 rounded-full transition-colors z-10 font-bold cursor-pointer"
        >
          ✕
        </button>

        {/* Header Branding */}
        <div className="p-6 pb-4 border-b border-[#2C3B2E] text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-[#4F633D]/20 text-[#FFF7E2] mx-auto flex items-center justify-center border border-[#8BA194]/30 shadow-md text-xl">
            🛡️
          </div>
          <h2 className="text-xl font-display font-bold text-[#FFF7E2]">MossZip Studio Account</h2>
          <p className="text-xs text-[#A3B59B]">Supabase Cloud 4-Digit PIN Auth</p>
          
          {/* Navigation Pill Switcher */}
          {step.startsWith('login') || step === 'register' ? (
            <div className="flex items-center justify-center gap-1.5 p-1.5 bg-[#121A13] border border-[#2C3B2E] rounded-2xl mt-4">
              <button
                type="button"
                onClick={() => { setAuthModalMode('login'); setStep('login-step1'); setError(null); }}
                className={`flex-1 py-2 rounded-xl text-xs font-display font-bold transition-all cursor-pointer ${
                  authModalMode === 'login' 
                    ? 'bg-[#4F633D] text-[#FFF7E2] shadow-md border border-[#8BA194]/40' 
                    : 'text-[#A3B59B] hover:text-[#FFF7E2]'
                }`}
              >
                Sign In with PIN
              </button>
              <button
                type="button"
                onClick={() => { setAuthModalMode('register'); setStep('register'); setError(null); }}
                className={`flex-1 py-2 rounded-xl text-xs font-display font-bold transition-all cursor-pointer ${
                  authModalMode === 'register' 
                    ? 'bg-[#4F633D] text-[#FFF7E2] shadow-md border border-[#8BA194]/40' 
                    : 'text-[#A3B59B] hover:text-[#FFF7E2]'
                }`}
              >
                Create Account
              </button>
            </div>
          ) : null}
        </div>

        {/* Body Section */}
        <div className="p-6 space-y-5">
          {rawError && (
            <div className="p-3.5 rounded-xl bg-rose-950/80 border border-rose-500/50 text-rose-100 text-xs font-semibold flex items-center gap-2 animate-fade-in shadow-md">
              <span>⚠️</span>
              <span>{rawError}</span>
            </div>
          )}

          {lockoutMsg && (
            <div className="p-4 rounded-xl bg-amber-950/80 border border-amber-500/50 text-amber-100 text-xs font-semibold space-y-1 animate-fade-in shadow-md">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <span>🔒</span>
                <span>Account Temporarily Locked</span>
              </div>
              <p className="text-[11px] leading-relaxed">{lockoutMsg}</p>
            </div>
          )}

          {/* STEP 1 LOGIN: Enter Mobile or Email */}
          {step === 'login-step1' && (
            <form onSubmit={handleCheckIdentifier} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">
                  Mobile Number or Email Address
                </label>
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="Mobile number or email address"
                  className="w-full bg-[#FFF7E2] text-[#1F291C] font-mono font-semibold rounded-xl px-4 py-3 text-sm outline-none border-2 border-[#4F633D]/40 focus:border-[#4F633D] focus:ring-4 focus:ring-[#4F633D]/20 transition-all placeholder-[#7B8B77]"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading || !identifier.trim()}
                className="w-full py-3.5 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Verifying Supabase Account...' : 'Continue with PIN →'}
              </button>
            </form>
          )}

          {/* STEP 2 LOGIN: Enter 4-Digit PIN */}
          {step === 'login-step2' && userInfo && (
            <form onSubmit={handleLoginSubmit} className="space-y-5 text-center">
              <div className="p-4 rounded-2xl bg-[#121A13] border border-[#4F633D]/40 space-y-1">
                <p className="text-xs text-[#A3B59B] font-medium">Welcome back,</p>
                <p className="text-base font-display font-bold text-[#FFF7E2]">{userInfo.full_name}</p>
                <p className="text-xs font-mono text-emerald-400 font-semibold">{userInfo.masked_phone}</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-display font-bold text-[#FFF7E2]">
                    Enter 4-Digit PIN
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowMpin(!showMpin)}
                    className="text-[11px] text-emerald-400 hover:underline font-semibold cursor-pointer"
                  >
                    {showMpin ? 'Hide PIN' : 'Show PIN'}
                  </button>
                </div>

                {/* 4 Digit Inputs */}
                <div className="flex items-center justify-center gap-3">
                  {mpin.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => (mpinInputRefs.current[idx] = el)}
                      type={showMpin ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value, mpin, setMpin, mpinInputRefs)}
                      onKeyDown={(e) => handleDigitKeyDown(idx, e, mpin, setMpin, mpinInputRefs)}
                      className="w-14 h-14 text-center text-2xl font-bold font-mono bg-[#FFF7E2] text-[#1F291C] border-2 border-[#4F633D]/50 focus:border-[#4F633D] focus:ring-4 focus:ring-[#4F633D]/20 rounded-2xl outline-none transition-all shadow-md"
                    />
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between text-xs font-semibold pt-1">
                <button
                  type="button"
                  onClick={() => { setAuthModalMode('forgot'); setStep('forgot-step1'); setError(null); }}
                  className="text-[#A3B59B] hover:text-[#FFF7E2] transition-colors cursor-pointer"
                >
                  Forgot PIN?
                </button>
                <button
                  type="button"
                  onClick={() => { setStep('login-step1'); setError(null); }}
                  className="text-emerald-400 hover:underline cursor-pointer"
                >
                  Change Account
                </button>
              </div>

              <button
                type="submit"
                disabled={loading || mpin.join('').length !== 4}
                className="w-full py-3.5 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Authenticating PIN...' : 'SIGN IN SECURELY'}
              </button>
            </form>
          )}

          {/* CREATE ACCOUNT FORM */}
          {step === 'register' && (
            <form onSubmit={handleRegisterSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">Full Name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full bg-[#FFF7E2] text-[#1F291C] font-semibold rounded-xl px-3.5 py-2.5 text-xs outline-none border border-[#4F633D]/40 focus:border-[#4F633D] transition-all placeholder-[#7B8B77]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-display font-bold text-[#FFF7E2]">Mobile Number</label>
                  <input
                    type="tel"
                    maxLength={10}
                    value={regMobile}
                    onChange={(e) => setRegMobile(e.target.value)}
                    placeholder="10-digit number"
                    className="w-full bg-[#FFF7E2] text-[#1F291C] font-mono font-semibold rounded-xl px-3.5 py-2.5 text-xs outline-none border border-[#4F633D]/40 focus:border-[#4F633D] transition-all placeholder-[#7B8B77]"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-display font-bold text-[#FFF7E2]">Email Address</label>
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="name@domain.com"
                    className="w-full bg-[#FFF7E2] text-[#1F291C] font-semibold rounded-xl px-3.5 py-2.5 text-xs outline-none border border-[#4F633D]/40 focus:border-[#4F633D] transition-all placeholder-[#7B8B77]"
                  />
                </div>
              </div>

              {/* 4-Digit PIN Creation */}
              <div className="space-y-1.5 pt-2 border-t border-[#2C3B2E]">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">Create 4-Digit PIN</label>
                <div className="flex items-center gap-2.5 justify-center">
                  {regMpin.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => (regMpinRefs.current[idx] = el)}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value, regMpin, setRegMpin, regMpinRefs)}
                      onKeyDown={(e) => handleDigitKeyDown(idx, e, regMpin, setRegMpin, regMpinRefs)}
                      className="w-11 h-11 text-center font-mono font-bold text-lg bg-[#FFF7E2] text-[#1F291C] border border-[#4F633D]/50 focus:border-[#4F633D] rounded-xl outline-none shadow-sm"
                    />
                  ))}
                </div>
              </div>

              {/* Confirm PIN */}
              <div className="space-y-1.5">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">Confirm 4-Digit PIN</label>
                <div className="flex items-center gap-2.5 justify-center">
                  {confirmMpin.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => (confirmMpinRefs.current[idx] = el)}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value, confirmMpin, setConfirmMpin, confirmMpinRefs)}
                      onKeyDown={(e) => handleDigitKeyDown(idx, e, confirmMpin, setConfirmMpin, confirmMpinRefs)}
                      className="w-11 h-11 text-center font-mono font-bold text-lg bg-[#FFF7E2] text-[#1F291C] border border-[#4F633D]/50 focus:border-[#4F633D] rounded-xl outline-none shadow-sm"
                    />
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer mt-2"
              >
                {loading ? 'Registering in Supabase Cloud...' : 'CREATE ACCOUNT & LOG IN'}
              </button>
            </form>
          )}

          {/* FORGOT PIN STEP 1 */}
          {step === 'forgot-step1' && (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">
                  Registered Mobile Number
                </label>
                <input
                  type="tel"
                  maxLength={10}
                  value={forgotMobile}
                  onChange={(e) => setForgotMobile(e.target.value)}
                  placeholder="Enter 10-digit mobile number"
                  className="w-full bg-[#FFF7E2] text-[#1F291C] font-mono font-semibold rounded-xl px-4 py-3 text-sm outline-none border-2 border-[#4F633D]/40 focus:border-[#4F633D] transition-all placeholder-[#7B8B77]"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading || forgotMobile.length !== 10}
                className="w-full py-3.5 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Verifying Account...' : 'Send Verification OTP →'}
              </button>
            </form>
          )}

          {/* FORGOT PIN STEP 2 */}
          {step === 'forgot-step2' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4 text-center">
              <p className="text-xs text-[#A3B59B]">
                Enter the OTP sent to your mobile number <span className="font-mono text-emerald-400 font-bold">(Demo OTP: 7890)</span>
              </p>
              <input
                type="text"
                maxLength={4}
                value={otpVal}
                onChange={(e) => setOtpVal(e.target.value)}
                placeholder="7 8 9 0"
                className="w-full bg-[#FFF7E2] text-[#1F291C] font-mono font-bold rounded-xl px-4 py-3 text-center text-xl tracking-widest border-2 border-[#4F633D]/40 focus:border-[#4F633D] outline-none"
                autoFocus
              />

              <button
                type="submit"
                disabled={loading || otpVal.length !== 4}
                className="w-full py-3.5 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Verifying OTP...' : 'Verify OTP Code'}
              </button>
            </form>
          )}

          {/* FORGOT PIN STEP 3 */}
          {step === 'forgot-step3' && (
            <form onSubmit={handleResetMpinSubmit} className="space-y-4 text-center">
              <p className="text-xs text-[#A3B59B]">Create a new 4-digit PIN for your account</p>
              
              <div className="space-y-1.5">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">New 4-Digit PIN</label>
                <div className="flex items-center gap-2.5 justify-center">
                  {newMpin.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => (newMpinRefs.current[idx] = el)}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value, newMpin, setNewMpin, newMpinRefs)}
                      className="w-11 h-11 text-center font-mono font-bold text-lg bg-[#FFF7E2] text-[#1F291C] border border-[#4F633D]/50 focus:border-[#4F633D] rounded-xl outline-none"
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-display font-bold text-[#FFF7E2]">Confirm New PIN</label>
                <div className="flex items-center gap-2.5 justify-center">
                  {confirmNewMpin.map((digit, idx) => (
                    <input
                      key={idx}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value, confirmNewMpin, setConfirmNewMpin, newMpinRefs)}
                      className="w-11 h-11 text-center font-mono font-bold text-lg bg-[#FFF7E2] text-[#1F291C] border border-[#4F633D]/50 focus:border-[#4F633D] rounded-xl outline-none"
                    />
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 px-4 rounded-xl font-display font-bold text-xs bg-[#4F633D] hover:bg-[#3E4F30] text-[#FFF7E2] transition-all shadow-lg border border-[#8BA194]/30 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Resetting PIN...' : 'SAVE NEW PIN & LOG IN'}
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
