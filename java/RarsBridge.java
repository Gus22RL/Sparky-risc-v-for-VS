import rars.AssemblyException;
import rars.ErrorList;
import rars.ErrorMessage;
import rars.Globals;
import rars.ProgramStatement;
import rars.RISCVprogram;
import rars.Settings;
import rars.SimulationException;
import rars.assembler.Symbol;
import rars.riscv.AbstractSyscall;
import rars.riscv.ExtendedInstruction;
import rars.riscv.Instruction;
import rars.riscv.InstructionSet;
import rars.riscv.SyscallLoader;
import rars.riscv.hardware.AccessNotice;
import rars.riscv.hardware.AddressErrorException;
import rars.riscv.hardware.MemoryAccessNotice;
import rars.riscv.hardware.ControlAndStatusRegisterFile;
import rars.riscv.hardware.FloatingPointRegisterFile;
import rars.riscv.hardware.InterruptController;
import rars.riscv.hardware.Memory;
import rars.riscv.hardware.MemoryConfiguration;
import rars.riscv.hardware.MemoryConfigurations;
import rars.riscv.hardware.Register;
import rars.riscv.hardware.RegisterFile;
import rars.simulator.BackStepper;
import rars.simulator.ProgramArgumentList;
import rars.simulator.Simulator;
import rars.simulator.SimulatorNotice;
import rars.util.SystemIO;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Bridge between the VS Code extension and the unmodified RARS jar.
 *
 * Protocol: one JSON object per line on stdin (requests) and stdout (responses and events).
 *   request : {"id":1,"cmd":"assemble", ...}
 *   response: {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}
 *   event   : {"event":"stopped"|"terminated"|"output"|"inputWait"|"ready", ...}
 *
 * All simulation logic is RARS's own (RISCVprogram, Simulator, BackStepper, RegisterFile, Memory, SystemIO).
 */
public class RarsBridge {
    private static final Charset UTF8 = StandardCharsets.UTF_8;
    private static final Object OUT_LOCK = new Object();
    private static PrintStream proto;

    // ---- session state -------------------------------------------------------------------
    private static RISCVprogram prog;
    private static ArrayList<RISCVprogram> progs = new ArrayList<RISCVprogram>();
    private static Memory assembledMem;
    private static Memory simMem;
    private static boolean loaded;
    private static volatile boolean busy;
    private static boolean terminated;
    private static boolean faulted;
    private static int[] breakpoints = new int[0];
    private static boolean reverse = true;
    private static boolean startAtMain;
    private static List<String> programArgs = new ArrayList<String>();
    private static final BlockingIn STDIN = new BlockingIn();
    private static final EventOut STDOUT = new EventOut("stdout");
    private static final EventOut STDERR = new EventOut("stderr");
    private static boolean rv64Applied;
    private static boolean optionsApplied;

    // Memory words written since the last "writes" request (used by the views to highlight changes, like RARS does).
    private static final java.util.LinkedHashSet<Long> WRITES = new java.util.LinkedHashSet<Long>();
    private static boolean writesOverflow;
    private static final java.util.Observer WRITE_OBSERVER = new java.util.Observer() {
        public void update(java.util.Observable o, Object arg) {
            if (!(arg instanceof MemoryAccessNotice)) return;
            MemoryAccessNotice n = (MemoryAccessNotice) arg;
            if (n.getAccessType() != AccessNotice.WRITE) return;
            long a = n.getAddress() & 0xFFFFFFFFL;
            long first = a & ~3L;
            long last = (a + Math.max(n.getLength(), 1) - 1) & ~3L;
            synchronized (WRITES) {
                for (long x = first; x <= last; x += 4) {
                    if (WRITES.size() < 8192) WRITES.add(Long.valueOf(x));
                    else writesOverflow = true;
                }
            }
        }
    };

    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(new ThreadFactory() {
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "rars-sim");
            t.setDaemon(true);
            return t;
        }
    });

    public static void main(String[] args) throws Exception {
        proto = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
        // Anything RARS prints on System.out must not corrupt the protocol channel.
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8"));
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, UTF8));

        Globals.initialize();
        Simulator.getInstance().addObserver(SIM_OBSERVER);
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            public void uncaughtException(Thread t, Throwable e) {
                if ("RISCV".equals(t.getName())) {
                    synchronized (STOP_LOCK) {
                        lastCrash = e;
                        STOP_LOCK.notifyAll();
                    }
                } else {
                    e.printStackTrace();
                }
            }
        });
        emit(obj("event", "ready", "version", Globals.version));

        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            Map<String, Object> req;
            try {
                req = asMap(Json.parse(line));
            } catch (Exception e) {
                System.err.println("bad request: " + line);
                continue;
            }
            dispatch(req);
        }
        System.exit(0);
    }

    // ---- transport ---------------------------------------------------------------------
    private static void emit(Map<String, Object> m) {
        String s = Json.stringify(m);
        synchronized (OUT_LOCK) {
            proto.println(s);
            proto.flush();
        }
    }

    private static void reply(Object id, Map<String, Object> result) {
        emit(obj("id", id, "ok", Boolean.TRUE, "result", result == null ? new LinkedHashMap<String, Object>() : result));
    }

    private static void replyError(Object id, Throwable t) {
        String msg = t.getMessage();
        if (msg == null || msg.isEmpty()) msg = t.getClass().getSimpleName();
        emit(obj("id", id, "ok", Boolean.FALSE, "error", msg));
    }

    // ---- dispatch ----------------------------------------------------------------------
    private static void dispatch(Map<String, Object> req) {
        final Object id = req.get("id");
        String cmd = str(req, "cmd", "");
        try {
            Map<String, Object> res = null;
            Runnable after = null;
            if (cmd.equals("instructions")) res = cmdInstructions();
            else if (cmd.equals("syscalls")) res = cmdSyscalls();
            else if (cmd.equals("lint")) res = cmdLint(req);
            else if (cmd.equals("assemble")) res = cmdAssemble(req);
            else if (cmd.equals("reset")) res = cmdReset();
            else if (cmd.equals("text")) res = obj("text", textSegment());
            else if (cmd.equals("labels")) res = obj("labels", labels());
            else if (cmd.equals("registers")) res = cmdRegisters(req);
            else if (cmd.equals("setRegister")) res = cmdSetRegister(req);
            else if (cmd.equals("memoryInfo")) res = cmdMemoryInfo();
            else if (cmd.equals("writes")) res = cmdWrites();
            else if (cmd.equals("readMemory")) res = cmdReadMemory(req);
            else if (cmd.equals("writeMemory")) res = cmdWriteMemory(req);
            else if (cmd.equals("setBreakpoints")) res = cmdSetBreakpoints(req);
            else if (cmd.equals("run") || cmd.equals("continue")) after = startRun(0);
            else if (cmd.equals("step")) after = startRun(1);
            else if (cmd.equals("stepBack")) after = cmdStepBack();
            else if (cmd.equals("pause")) cmdPause();
            else if (cmd.equals("stop")) cmdStop();
            else if (cmd.equals("input")) STDIN.feed(str(req, "text", "").getBytes(UTF8));
            else if (cmd.equals("status")) res = cmdStatus();
            else if (cmd.equals("exit")) {
                reply(id, null);
                System.exit(0);
            } else throw new IllegalArgumentException("unknown command: " + cmd);

            reply(id, res);
            if (after != null) after.run();
        } catch (Throwable t) {
            replyError(id, t);
        }
    }

    // ---- options -----------------------------------------------------------------------
    private static void applyOptions(Map<String, Object> o) {
        boolean rv64 = bool(o, "rv64", false);
        Settings st = Globals.getSettings();
        st.setBooleanSettingNonPersistent(Settings.Bool.RV64_ENABLED, rv64);
        if (!optionsApplied || rv64 != rv64Applied) {
            InstructionSet.rv64 = rv64;
            Globals.instructionSet.populate();
            rv64Applied = rv64;
            optionsApplied = true;
        }
        st.setBooleanSettingNonPersistent(Settings.Bool.SELF_MODIFYING_CODE_ENABLED, bool(o, "selfModifyingCode", false));
        String mc = str(o, "memoryConfig", "Default");
        MemoryConfiguration cfg = MemoryConfigurations.getConfigurationByName(mc);
        if (cfg == null) cfg = MemoryConfigurations.getDefaultConfiguration();
        MemoryConfigurations.setCurrentConfiguration(cfg);
        Memory.setConfiguration();
    }

    // ---- static info -------------------------------------------------------------------
    private static Map<String, Object> cmdInstructions() {
        List<Object> list = new ArrayList<Object>();
        for (Instruction i : Globals.instructionSet.getInstructionList()) {
            list.add(obj("name", i.getName(), "example", i.getExampleFormat(), "description", i.getDescription(),
                    "pseudo", Boolean.valueOf(i instanceof ExtendedInstruction)));
        }
        return obj("instructions", list);
    }

    private static Map<String, Object> cmdSyscalls() {
        List<Object> list = new ArrayList<Object>();
        for (AbstractSyscall s : SyscallLoader.getSyscallList()) {
            list.add(obj("name", s.getName(), "number", Integer.valueOf(s.getNumber()), "description", s.getDescription(),
                    "inputs", s.getInputs(), "outputs", s.getOutputs()));
        }
        return obj("syscalls", list);
    }

    // ---- lint (assemble from text, never touches the running session when used in its own process) ---
    private static Map<String, Object> cmdLint(Map<String, Object> req) {
        Map<String, Object> o = asMap(req.get("options"));
        applyOptions(o);
        RISCVprogram p = new RISCVprogram();
        // RARS reads files line by line (so CRLF is fine on disk), but fromString() only splits on '\n'.
        // The editor hands us its own line endings, so normalise them or every "\r" becomes a bogus error.
        p.fromString(str(req, "text", "").replace("\r\n", "\n").replace('\r', '\n'));
        ArrayList<RISCVprogram> l = new ArrayList<RISCVprogram>();
        l.add(p);
        Memory old = Memory.swapInstance(new Memory());
        ErrorList errs;
        try {
            p.tokenize();
            errs = p.assemble(l, bool(o, "pseudo", true), bool(o, "warningsAreErrors", false));
        } catch (AssemblyException e) {
            errs = e.errors();
        } finally {
            Memory.swapInstance(old);
        }
        return obj("diagnostics", diagnostics(errs));
    }

    private static List<Object> diagnostics(ErrorList errs) {
        List<Object> out = new ArrayList<Object>();
        if (errs == null) return out;
        java.util.HashSet<String> seen = new java.util.HashSet<String>();
        for (ErrorMessage m : errs.getErrorMessages()) {
            // The tokenizer and the assembler can both report the same problem.
            String key = m.getFilename() + "\u0000" + m.getLine() + "\u0000" + m.getPosition() + "\u0000" + m.isWarning() + "\u0000" + m.getMessage();
            if (!seen.add(key)) continue;
            out.add(obj("file", m.getFilename(), "line", Integer.valueOf(m.getLine()), "column", Integer.valueOf(m.getPosition()),
                    "message", m.getMessage(), "severity", m.isWarning() ? "warning" : "error"));
        }
        return out;
    }

    // ---- assemble + session setup --------------------------------------------------------
    private static Map<String, Object> cmdAssemble(Map<String, Object> req) throws Exception {
        if (busy) throw new IllegalStateException("The simulator is running");
        loaded = false;
        terminated = false;
        faulted = false;
        Map<String, Object> o = asMap(req.get("options"));
        applyOptions(o);
        reverse = bool(o, "reverse", true);
        startAtMain = bool(o, "startAtMain", false);
        programArgs = new ArrayList<String>();
        for (Object a : asList(o.get("programArguments"))) programArgs.add(String.valueOf(a));

        ArrayList<String> files = new ArrayList<String>();
        for (Object f : asList(req.get("files"))) files.add(String.valueOf(f));
        if (files.isEmpty()) throw new IllegalArgumentException("no files to assemble");
        String main = str(req, "main", files.get(0));

        prog = new RISCVprogram();
        Globals.program = prog;
        assembledMem = new Memory();
        Memory old = Memory.swapInstance(assembledMem);
        ErrorList errs;
        ArrayList<RISCVprogram> list = null;
        try {
            list = prog.prepareFilesForAssembly(files, main, null);
            errs = prog.assemble(list, bool(o, "pseudo", true), bool(o, "warningsAreErrors", false));
        } catch (AssemblyException e) {
            errs = e.errors();
        } finally {
            Memory.swapInstance(old);
        }
        List<Object> diags = diagnostics(errs);
        boolean failed = errs == null || errs.errorsOccurred();
        if (failed) return obj("ok", Boolean.FALSE, "diagnostics", diags);

        progs = list;
        setupSimulation();
        return obj("ok", Boolean.TRUE, "diagnostics", diags, "startPc", Long.valueOf(unsigned(RegisterFile.getProgramCounter())),
                "text", textSegment(), "labels", labels(), "memory", memoryInfo());
    }

    private static Map<String, Object> cmdReset() {
        if (busy) throw new IllegalStateException("The simulator is running");
        if (assembledMem == null) throw new IllegalStateException("nothing assembled");
        setupSimulation();
        return obj("pc", Long.valueOf(unsigned(RegisterFile.getProgramCounter())));
    }

    /** Same sequence rars.api.Program.setup uses, but keeping the simulation memory active for stepping. */
    private static void setupSimulation() {
        RegisterFile.initializeProgramCounter(startAtMain);
        int startPC = RegisterFile.getProgramCounter();
        RegisterFile.resetRegisters();
        FloatingPointRegisterFile.resetRegisters();
        ControlAndStatusRegisterFile.resetRegisters();
        InterruptController.reset();
        RegisterFile.initializeProgramCounter(startPC);
        Globals.exitCode = 0;
        simMem = new Memory();
        simMem.copyFrom(assembledMem);
        Memory.swapInstance(simMem);
        synchronized (WRITES) {
            WRITES.clear();
            writesOverflow = false;
        }
        try {
            simMem.addObserver(WRITE_OBSERVER, Memory.dataSegmentBaseAddress & ~3, Memory.userHighAddress & ~3);
        } catch (AddressErrorException e) {
            System.err.println("could not observe memory writes: " + e.getMessage());
        }
        if (!programArgs.isEmpty()) new ProgramArgumentList(new ArrayList<String>(programArgs)).storeProgramArguments();
        prog.getBackStepper().setEnabled(reverse);
        STDIN.clear();
        SystemIO.swapData(new SystemIO.Data(STDIN, STDOUT, STDERR));
        loaded = true;
        terminated = false;
        faulted = false;
        busy = false;
    }

    private static List<Object> textSegment() {
        List<Object> out = new ArrayList<Object>();
        if (prog == null) return out;
        for (ProgramStatement s : prog.getMachineList()) {
            String file = s.getSourceProgram() != null ? s.getSourceProgram().getFilename() : "";
            out.add(obj("address", Long.valueOf(unsigned(s.getAddress())), "code", Long.valueOf(unsigned(s.getBinaryStatement())),
                    "basic", s.getPrintableBasicAssemblyStatement(), "source", s.getSource(),
                    "line", Integer.valueOf(s.getSourceLine()), "file", file));
        }
        return out;
    }

    private static List<Object> labels() {
        List<Object> out = new ArrayList<Object>();
        java.util.HashSet<String> seen = new java.util.HashSet<String>();
        for (RISCVprogram p : progs) {
            for (Object so : p.getLocalSymbolTable().getAllSymbols()) {
                Symbol s = (Symbol) so;
                if (!seen.add(s.getName() + "@" + s.getAddress())) continue;
                out.add(obj("name", s.getName(), "address", Long.valueOf(unsigned(s.getAddress())),
                        "type", s.getType() ? "data" : "text", "file", p.getFilename()));
            }
        }
        for (Object so : Globals.symbolTable.getAllSymbols()) {
            Symbol s = (Symbol) so;
            if (!seen.add(s.getName() + "@" + s.getAddress())) continue;
            out.add(obj("name", s.getName(), "address", Long.valueOf(unsigned(s.getAddress())),
                    "type", s.getType() ? "data" : "text", "file", ""));
        }
        return out;
    }

    // ---- registers & memory ------------------------------------------------------------
    private static Map<String, Object> cmdRegisters(Map<String, Object> req) {
        String bank = str(req, "bank", "int");
        Register[] regs;
        if (bank.equals("fp")) regs = FloatingPointRegisterFile.getRegisters();
        else if (bank.equals("csr")) regs = ControlAndStatusRegisterFile.getRegisters();
        else regs = RegisterFile.getRegisters();
        List<Object> out = new ArrayList<Object>();
        for (Register r : regs) {
            long v = r.getValueNoNotify();
            Map<String, Object> m = obj("name", r.getName(), "number", Integer.valueOf(r.getNumber()), "value", Long.toString(v));
            if (bank.equals("fp")) {
                m.put("f32", Float.toString(Float.intBitsToFloat((int) v)));
                m.put("f64", Double.toString(Double.longBitsToDouble(v)));
            }
            out.add(m);
        }
        return obj("registers", out, "pc", Long.valueOf(unsigned(RegisterFile.getProgramCounter())), "rv64", Boolean.valueOf(InstructionSet.rv64));
    }

    private static Map<String, Object> cmdSetRegister(Map<String, Object> req) {
        if (busy) throw new IllegalStateException("The simulator is running");
        String bank = str(req, "bank", "int");
        String name = str(req, "name", "");
        long v = parseLong(req.get("value"));
        if (bank.equals("int")) {
            if (name.equals("pc")) {
                RegisterFile.initializeProgramCounter((int) v);
            } else if (name.matches("x\\d+")) {
                RegisterFile.updateRegister(Integer.parseInt(name.substring(1)), v);
            } else {
                RegisterFile.updateRegister(name, v);
            }
        } else if (bank.equals("fp")) {
            Register r = FloatingPointRegisterFile.getRegister(name);
            if (r == null) throw new IllegalArgumentException("unknown register " + name);
            FloatingPointRegisterFile.updateRegisterLong(r.getNumber(), v);
        } else {
            ControlAndStatusRegisterFile.updateRegisterBackdoor(name, v);
        }
        return null;
    }

    private static Map<String, Object> cmdMemoryInfo() {
        return memoryInfo();
    }

    /** Word addresses written (by the program or by the user) since the previous call; clears the log. */
    private static Map<String, Object> cmdWrites() {
        List<Object> out = new ArrayList<Object>();
        boolean overflow;
        synchronized (WRITES) {
            out.addAll(WRITES);
            overflow = writesOverflow;
            WRITES.clear();
            writesOverflow = false;
        }
        return obj("addresses", out, "overflow", Boolean.valueOf(overflow));
    }

    private static Map<String, Object> memoryInfo() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("textBase", Long.valueOf(unsigned(Memory.textBaseAddress)));
        m.put("textLimit", Long.valueOf(unsigned(Memory.textLimitAddress)));
        m.put("dataBase", Long.valueOf(unsigned(Memory.dataBaseAddress)));
        m.put("dataSegmentBase", Long.valueOf(unsigned(Memory.dataSegmentBaseAddress)));
        m.put("externBase", Long.valueOf(unsigned(Memory.externBaseAddress)));
        m.put("heapBase", Long.valueOf(unsigned(Memory.heapBaseAddress)));
        m.put("globalPointer", Long.valueOf(unsigned(Memory.globalPointer)));
        m.put("stackPointer", Long.valueOf(unsigned(Memory.stackPointer)));
        m.put("stackBase", Long.valueOf(unsigned(Memory.stackBaseAddress)));
        m.put("stackLimit", Long.valueOf(unsigned(Memory.stackLimitAddress)));
        m.put("userHigh", Long.valueOf(unsigned(Memory.userHighAddress)));
        m.put("kernelBase", Long.valueOf(unsigned(Memory.kernelBaseAddress)));
        m.put("kernelHigh", Long.valueOf(unsigned(Memory.kernelHighAddress)));
        m.put("memoryMapBase", Long.valueOf(unsigned(Memory.memoryMapBaseAddress)));
        m.put("memoryMapLimit", Long.valueOf(unsigned(Memory.memoryMapLimitAddress)));
        m.put("dataSegmentLimit", Long.valueOf(unsigned(Memory.dataSegmentLimitAddress)));
        return m;
    }

    private static Map<String, Object> cmdReadMemory(Map<String, Object> req) {
        long addr = parseLong(req.get("address"));
        int words = (int) parseLong(req.get("words"));
        if (words < 0 || words > 65536) throw new IllegalArgumentException("words out of range");
        Memory mem = Memory.getInstance();
        List<Object> out = new ArrayList<Object>(words);
        for (int i = 0; i < words; i++) {
            int a = (int) (addr + 4L * i);
            Object v;
            try {
                Integer w = mem.getRawWordOrNull(a);
                v = Long.valueOf(w == null ? 0L : unsigned(w.intValue()));
            } catch (AddressErrorException e) {
                v = null;
            }
            out.add(v);
        }
        return obj("address", Long.valueOf(addr & 0xFFFFFFFFL), "words", out);
    }

    private static Map<String, Object> cmdWriteMemory(Map<String, Object> req) throws Exception {
        if (busy) throw new IllegalStateException("The simulator is running");
        int addr = (int) parseLong(req.get("address"));
        int value = (int) parseLong(req.get("value"));
        int size = (int) (req.get("size") == null ? 4 : parseLong(req.get("size")));
        Memory.getInstance().set(addr, value, size);
        return null;
    }

    private static Map<String, Object> cmdSetBreakpoints(Map<String, Object> req) {
        List<Object> a = asList(req.get("addresses"));
        int[] bps = new int[a.size()];
        for (int i = 0; i < bps.length; i++) bps[i] = (int) parseLong(a.get(i));
        Arrays.sort(bps);
        breakpoints = bps;
        return null;
    }

    private static Map<String, Object> cmdStatus() {
        return obj("loaded", Boolean.valueOf(loaded), "busy", Boolean.valueOf(busy), "terminated", Boolean.valueOf(terminated),
                "faulted", Boolean.valueOf(faulted), "pc", Long.valueOf(unsigned(RegisterFile.getProgramCounter())),
                "canStepBack", Boolean.valueOf(canStepBack()));
    }

    // ---- execution ---------------------------------------------------------------------
    /** Validates and returns the work to run after the response was written (so events come after the reply). */
    private static Runnable startRun(final int maxSteps) {
        if (!loaded) throw new IllegalStateException("No program is assembled");
        if (busy) throw new IllegalStateException("The simulator is already running");
        if (terminated) throw new IllegalStateException("The program already finished; restart it first");
        if (faulted) throw new IllegalStateException("The program stopped on an exception; restart it first");
        pendingInterrupt = NONE; // a request left over from a previous run must not leak into this one
        busy = true;
        final int[] bps = maxSteps == 0 ? breakpoints : null;
        return new Runnable() {
            public void run() {
                WORKER.submit(new Runnable() {
                    public void run() {
                        execute(maxSteps, bps);
                    }
                });
            }
        };
    }

    // The simulation runs on RARS's own "RISCV" thread (Simulator.startSimulation, exactly like the RARS GUI does),
    // which is what makes pauseExecution()/stopExecution() safe. We wait here for its stop notification.
    private static final Object STOP_LOCK = new Object();
    private static SimulatorNotice lastStop;
    private static Throwable lastCrash;
    private static final java.util.Observer SIM_OBSERVER = new java.util.Observer() {
        public void update(java.util.Observable o, Object arg) {
            if (arg instanceof SimulatorNotice && ((SimulatorNotice) arg).getAction() == SimulatorNotice.SIMULATOR_STOP) {
                synchronized (STOP_LOCK) {
                    lastStop = (SimulatorNotice) arg;
                    STOP_LOCK.notifyAll();
                }
            }
        }
    };

    private static void execute(int maxSteps, int[] bps) {
        Simulator.Reason reason = null;
        SimulationException exc = null;
        Throwable internal = null;
        synchronized (STOP_LOCK) {
            lastStop = null;
            lastCrash = null;
        }
        try {
            Simulator.getInstance().startSimulation(RegisterFile.getProgramCounter(), maxSteps, bps);
            applyPendingInterrupt();
            synchronized (STOP_LOCK) {
                while (lastStop == null && lastCrash == null) STOP_LOCK.wait();
                if (lastStop != null) {
                    reason = lastStop.getReason();
                    exc = lastStop.getException();
                    if (lastStop.getDone()) SystemIO.resetFiles();
                } else {
                    internal = lastCrash;
                }
            }
        } catch (Throwable t) {
            internal = t;
        }
        if (internal instanceof java.awt.HeadlessException) {
            internal = new IllegalStateException("This system call needs a GUI dialog, which is not available in VS Code. "
                    + "Use the console system calls instead (print/read int, string, char).");
        }
        try {
            SystemIO.flush(true);
        } catch (Throwable ignored) {
        }
        busy = false;
        int pc = RegisterFile.getProgramCounter();
        if (internal != null) {
            faulted = true;
            emit(obj("event", "stopped", "reason", "exception", "message", String.valueOf(internal.getMessage()),
                    "pc", Long.valueOf(unsigned(pc))));
            return;
        }
        if (exc != null) {
            faulted = true;
            ErrorMessage em = exc.error();
            Map<String, Object> ev = obj("event", "stopped", "reason", "exception",
                    "message", em != null ? em.getMessage() : String.valueOf(exc.getMessage()), "pc", Long.valueOf(unsigned(pc)));
            if (em != null) {
                ev.put("line", Integer.valueOf(em.getLine()));
                ev.put("file", em.getFilename());
            }
            emit(ev);
            return;
        }
        switch (reason) {
            case BREAKPOINT:
                boolean user = bps != null && Arrays.binarySearch(bps, pc) >= 0;
                emit(obj("event", "stopped", "reason", user ? "breakpoint" : "ebreak", "pc", Long.valueOf(unsigned(pc))));
                break;
            case MAX_STEPS:
                emit(obj("event", "stopped", "reason", "step", "pc", Long.valueOf(unsigned(pc))));
                break;
            case PAUSE:
                emit(obj("event", "stopped", "reason", "pause", "pc", Long.valueOf(unsigned(pc))));
                break;
            case STOP:
                terminated = true;
                emit(obj("event", "terminated", "reason", "stopped", "exitCode", Integer.valueOf(Globals.exitCode)));
                break;
            case CLIFF_TERMINATION:
                terminated = true;
                emit(obj("event", "terminated", "reason", "cliff", "exitCode", Integer.valueOf(Globals.exitCode),
                        "message", "Program terminated by dropping off the bottom."));
                break;
            case NORMAL_TERMINATION:
                terminated = true;
                emit(obj("event", "terminated", "reason", "exit", "exitCode", Integer.valueOf(Globals.exitCode),
                        "message", "Program terminated by calling exit."));
                break;
            default:
                faulted = true;
                emit(obj("event", "stopped", "reason", "exception", "message", "Simulation stopped: " + reason,
                        "pc", Long.valueOf(unsigned(pc))));
        }
    }

    // RARS ignores pauseExecution()/stopExecution() until its simulator thread exists. A Pause that arrives right after
    // Continue (before that thread was created) would be lost and the program would run forever, so the request is
    // remembered and applied as soon as the simulation has been started.
    private static final int NONE = 0;
    private static final int PAUSE = 1;
    private static final int STOP = 2;
    private static volatile int pendingInterrupt = NONE;

    private static void cmdPause() {
        if (!busy) return;
        if (pendingInterrupt < PAUSE) pendingInterrupt = PAUSE;
        Simulator.getInstance().pauseExecution();
    }

    private static void cmdStop() {
        if (!busy) return;
        pendingInterrupt = STOP;
        Simulator.getInstance().stopExecution();
    }

    private static void applyPendingInterrupt() {
        int p = pendingInterrupt;
        if (p == STOP) Simulator.getInstance().stopExecution();
        else if (p == PAUSE) Simulator.getInstance().pauseExecution();
    }

    // ---- reverse stepping ----------------------------------------------------------------
    private static boolean canStepBack() {
        if (!loaded || prog == null) return false;
        BackStepper bs = prog.getBackStepper();
        return bs != null && bs.enabled() && !bs.empty();
    }

    private static Runnable cmdStepBack() {
        if (!loaded) throw new IllegalStateException("No program is assembled");
        if (busy) throw new IllegalStateException("The simulator is running");
        if (!canStepBack()) throw new IllegalStateException("There is nothing to step back (reverse stepping is limited by RARS to the most recent instructions)");
        BackStepper bs = prog.getBackStepper();
        // RARS groups the undo log by statement. A taken jump/branch leaves its trailing CSR counters
        // (cycle/instret/time) in a separate group, so one RARS backStep() would leave a half-undone state.
        // Keep undoing while the group we just undid contained only CSR entries.
        int guard = 0;
        boolean onlyCsr;
        do {
            onlyCsr = topGroupIsOnlyCsr(bs);
            bs.backStep();
        } while (onlyCsr && !bs.empty() && ++guard < 8);
        terminated = false;
        faulted = false;
        final int pc = RegisterFile.getProgramCounter();
        return new Runnable() {
            public void run() {
                emit(obj("event", "stopped", "reason", "step", "pc", Long.valueOf(unsigned(pc))));
            }
        };
    }

    private static boolean topGroupIsOnlyCsr(BackStepper bs) {
        try {
            Field stackField = BackStepper.class.getDeclaredField("backSteps");
            stackField.setAccessible(true);
            Object stack = stackField.get(bs);
            Field topF = stack.getClass().getDeclaredField("top");
            topF.setAccessible(true);
            Field arrF = stack.getClass().getDeclaredField("stack");
            arrF.setAccessible(true);
            int top = topF.getInt(stack);
            Object arr = arrF.get(stack);
            if (top < 0) return false;
            Object first = Array.get(arr, top);
            Field actionF = null;
            Field stmtF = null;
            for (Field f : first.getClass().getDeclaredFields()) {
                f.setAccessible(true);
                if (f.getType() == ProgramStatement.class) stmtF = f;
                else if (f.getType().isEnum()) actionF = f;
            }
            if (actionF == null || stmtF == null) return false;
            Object stmt = stmtF.get(first);
            boolean any = false;
            for (int i = top; i >= 0; i--) {
                Object e = Array.get(arr, i);
                if (e == null || stmtF.get(e) != stmt) break;
                String action = ((Enum<?>) actionF.get(e)).name();
                if (!action.startsWith("CONTROL_AND_STATUS")) return false;
                any = true;
            }
            return any;
        } catch (Throwable t) {
            return false;
        }
    }

    // ---- helpers -----------------------------------------------------------------------
    private static long unsigned(int v) {
        return v & 0xFFFFFFFFL;
    }

    private static long parseLong(Object o) {
        if (o instanceof Number) return ((Number) o).longValue();
        String s = String.valueOf(o).trim();
        boolean neg = s.startsWith("-");
        if (neg) s = s.substring(1);
        long v;
        if (s.startsWith("0x") || s.startsWith("0X")) v = Long.parseUnsignedLong(s.substring(2), 16);
        else v = Long.parseUnsignedLong(s);
        return neg ? -v : v;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        if (o instanceof Map) return (Map<String, Object>) o;
        return new LinkedHashMap<String, Object>();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o) {
        if (o instanceof List) return (List<Object>) o;
        return new ArrayList<Object>();
    }

    private static String str(Map<String, Object> m, String key, String def) {
        Object v = m.get(key);
        return v == null ? def : String.valueOf(v);
    }

    private static boolean bool(Map<String, Object> m, String key, boolean def) {
        Object v = m.get(key);
        return v instanceof Boolean ? ((Boolean) v).booleanValue() : def;
    }

    private static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ---- program I/O: stdin blocks until the extension feeds text; stdout/stderr become events ----
    static final class BlockingIn extends ByteArrayInputStream {
        private final Object lock = new Object();
        private byte[] data = new byte[0];
        private int pos = 0;

        BlockingIn() {
            super(new byte[0]);
        }

        void feed(byte[] b) {
            synchronized (lock) {
                byte[] rest = Arrays.copyOfRange(data, pos, data.length);
                byte[] n = new byte[rest.length + b.length];
                System.arraycopy(rest, 0, n, 0, rest.length);
                System.arraycopy(b, 0, n, rest.length, b.length);
                data = n;
                pos = 0;
                lock.notifyAll();
            }
        }

        void clear() {
            synchronized (lock) {
                data = new byte[0];
                pos = 0;
            }
        }

        private void await() throws InterruptedException {
            boolean announced = false;
            while (pos >= data.length) {
                if (!announced) {
                    announced = true;
                    emit(obj("event", "inputWait"));
                }
                lock.wait();
            }
        }

        @Override
        public int read() {
            synchronized (lock) {
                try {
                    await();
                } catch (InterruptedException e) {
                    return -1;
                }
                return data[pos++] & 0xFF;
            }
        }

        @Override
        public int read(byte[] b, int off, int len) {
            if (len == 0) return 0;
            synchronized (lock) {
                try {
                    await();
                } catch (InterruptedException e) {
                    return -1;
                }
                int n = Math.min(len, data.length - pos);
                System.arraycopy(data, pos, b, off, n);
                pos += n;
                return n;
            }
        }

        @Override
        public int available() {
            synchronized (lock) {
                return data.length - pos;
            }
        }
    }

    static final class EventOut extends ByteArrayOutputStream {
        private final String stream;
        private byte[] carry = new byte[0];

        EventOut(String stream) {
            this.stream = stream;
        }

        @Override
        public synchronized void write(int b) {
            write(new byte[]{(byte) b}, 0, 1);
        }

        @Override
        public synchronized void write(byte[] b, int off, int len) {
            byte[] all = new byte[carry.length + len];
            System.arraycopy(carry, 0, all, 0, carry.length);
            System.arraycopy(b, off, all, carry.length, len);
            int complete = completeLength(all);
            carry = Arrays.copyOfRange(all, complete, all.length);
            if (complete > 0) {
                emit(obj("event", "output", "stream", stream, "text", new String(all, 0, complete, UTF8)));
            }
        }

        /** Length of the longest prefix that does not end in the middle of a UTF-8 sequence. */
        private static int completeLength(byte[] b) {
            int len = b.length;
            int i = len - 1;
            int cont = 0;
            while (i >= 0 && cont < 3 && (b[i] & 0xC0) == 0x80) {
                i--;
                cont++;
            }
            if (i < 0) return len;
            int lead = b[i] & 0xFF;
            int need = lead >= 0xF0 ? 3 : lead >= 0xE0 ? 2 : lead >= 0xC0 ? 1 : 0;
            return need > cont ? i : len;
        }
    }

    // ---- minimal JSON --------------------------------------------------------------------
    static final class Json {
        private final String s;
        private int p;

        private Json(String s) {
            this.s = s;
        }

        static Object parse(String s) {
            Json j = new Json(s);
            j.ws();
            Object v = j.value();
            j.ws();
            if (j.p != s.length()) throw new IllegalArgumentException("trailing characters in JSON");
            return v;
        }

        private void ws() {
            while (p < s.length() && Character.isWhitespace(s.charAt(p))) p++;
        }

        private Object value() {
            if (p >= s.length()) throw new IllegalArgumentException("unexpected end of JSON");
            char c = s.charAt(p);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", p)) {
                p += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", p)) {
                p += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", p)) {
                p += 4;
                return null;
            }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            p++;
            ws();
            if (s.charAt(p) == '}') {
                p++;
                return m;
            }
            while (true) {
                ws();
                String k = string();
                ws();
                if (s.charAt(p++) != ':') throw new IllegalArgumentException("expected ':'");
                ws();
                m.put(k, value());
                ws();
                char c = s.charAt(p++);
                if (c == '}') return m;
                if (c != ',') throw new IllegalArgumentException("expected ',' or '}'");
            }
        }

        private List<Object> array() {
            List<Object> l = new ArrayList<Object>();
            p++;
            ws();
            if (s.charAt(p) == ']') {
                p++;
                return l;
            }
            while (true) {
                ws();
                l.add(value());
                ws();
                char c = s.charAt(p++);
                if (c == ']') return l;
                if (c != ',') throw new IllegalArgumentException("expected ',' or ']'");
            }
        }

        private String string() {
            if (s.charAt(p) != '"') throw new IllegalArgumentException("expected string");
            p++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(p++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = s.charAt(p++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        sb.append((char) Integer.parseInt(s.substring(p, p + 4), 16));
                        p += 4;
                        break;
                    default: sb.append(e);
                }
            }
        }

        private Object number() {
            int st = p;
            while (p < s.length() && "+-0123456789.eE".indexOf(s.charAt(p)) >= 0) p++;
            String n = s.substring(st, p);
            if (n.isEmpty()) throw new IllegalArgumentException("bad JSON value at " + st);
            if (n.indexOf('.') >= 0 || n.indexOf('e') >= 0 || n.indexOf('E') >= 0) return Double.valueOf(n);
            return Long.valueOf(n);
        }

        static String stringify(Object o) {
            StringBuilder sb = new StringBuilder();
            write(sb, o);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        private static void write(StringBuilder sb, Object o) {
            if (o == null) sb.append("null");
            else if (o instanceof String) quote(sb, (String) o);
            else if (o instanceof Boolean || o instanceof Integer || o instanceof Long) sb.append(o);
            else if (o instanceof Number) sb.append(((Number) o).doubleValue());
            else if (o instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    quote(sb, e.getKey());
                    sb.append(':');
                    write(sb, e.getValue());
                }
                sb.append('}');
            } else if (o instanceof Collection) {
                sb.append('[');
                boolean first = true;
                for (Object x : (Collection<Object>) o) {
                    if (!first) sb.append(',');
                    first = false;
                    write(sb, x);
                }
                sb.append(']');
            } else quote(sb, o.toString());
        }

        private static void quote(StringBuilder sb, String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }
}
