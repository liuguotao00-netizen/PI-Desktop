// Windows 10+ / .NET Framework 4 process supervisor. Build process-helper.exe
// ahead of distribution; NEVER compile or extract it at runtime. No temporary
// files, PowerShell policy probes, caches or directory creation are required.
// Build: Framework64\v4.0.30319\csc.exe /nologo /optimize+ /target:exe
//        /r:System.Web.Extensions.dll /out:process-helper.exe process-helper.cs
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ProcessHelper
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr kind, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd,
        ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    public sealed class Configuration { public string executable; public string command; }

    static void Check(bool ok, string operation)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
    static byte[] ReadExact(Stream input, int count)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(bytes, offset, count - offset);
            if (read == 0) throw new EndOfStreamException("Supervisor configuration ended unexpectedly");
            offset += read;
        }
        return bytes;
    }
    static IntPtr Allocate(int size)
    {
        IntPtr result = Marshal.AllocHGlobal(size);
        Marshal.Copy(new byte[size], 0, result, size);
        return result;
    }

    static int Main()
    {
        IntPtr job = IntPtr.Zero, limits = IntPtr.Zero, attributes = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero, accounting = IntPtr.Zero;
        bool attributesReady = false;
        ProcessInformation process = new ProcessInformation();
        try
        {
            // Read exactly the frame, with no buffered reader to steal target stdin.
            Stream input = Console.OpenStandardInput();
            int length = BitConverter.ToInt32(ReadExact(input, 4), 0);
            if (length < 1 || length > 1048576) throw new InvalidDataException("Invalid configuration length");
            Configuration config = new JavaScriptSerializer().Deserialize<Configuration>(Encoding.UTF8.GetString(ReadExact(input, length)));
            job = CreateJobObject(IntPtr.Zero, null); // non-inheritable, unnamed
            Check(job != IntPtr.Zero, "CreateJobObject");
            int limitsSize = IntPtr.Size == 8 ? 144 : 112;
            limits = Allocate(limitsSize);
            Marshal.WriteInt32(limits, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, limits, (uint)limitsSize), "SetInformationJobObject");

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (attributeSize.ToInt64() <= 0) throw new InvalidOperationException("Invalid attribute list size");
            attributes = Allocate(attributeSize.ToInt32());
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize), "InitializeProcThreadAttributeList");
            attributesReady = true;
            jobList = Allocate(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobList, (IntPtr)IntPtr.Size,
                IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(JOB_LIST; requires Windows 10+)");

            StartupInfoEx startup = new StartupInfoEx();
            startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Info.Stdin = GetStdHandle(-10);
            startup.Info.Stdout = GetStdHandle(-11);
            startup.Info.Stderr = GetStdHandle(-12);
            foreach (IntPtr handle in new[] { startup.Info.Stdin, startup.Info.Stdout, startup.Info.Stderr })
                Check(SetHandleInformation(handle, 1, 1), "SetHandleInformation");
            startup.Attributes = attributes;
            // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
            // JOB_LIST assigns atomically, unlike CreateProcess then AssignProcess:
            // supervisor death during startup cannot strand even a suspended child.
            Check(CreateProcess(config.executable, new StringBuilder(config.command), IntPtr.Zero, IntPtr.Zero,
                true, 0x08080004, IntPtr.Zero, null, ref startup, out process), "CreateProcess");
            Check(ResumeThread(process.Thread) != uint.MaxValue, "ResumeThread");
            Check(WaitForSingleObject(process.Process, uint.MaxValue) == 0, "WaitForSingleObject");
            uint exitCode;
            Check(GetExitCodeProcess(process.Process, out exitCode), "GetExitCodeProcess");
            accounting = Allocate(48);
            while (true)
            {
                Check(QueryInformationJobObject(job, 1, accounting, 48, IntPtr.Zero), "QueryInformationJobObject");
                if (Marshal.ReadInt32(accounting, 40) == 0) break; // ActiveProcesses
                Thread.Sleep(20);
            }
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Process supervisor: " + error.Message);
            return 1; // Fail closed; never fall back to an unmanaged target.
        }
        finally
        {
            // Job is the sole owner; closing it kills all remaining descendants.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr memory in new[] { limits, attributes, jobList, accounting })
                if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
    }
}
