// KekeClipper - lanzador nativo para Windows.
// Abre una ventana propia (WebView2, el motor de Windows) y arranca el servidor local de la app.
// Compilar con launcher\build.ps1 (usa el compilador C# que trae Windows, no hace falta Visual Studio).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    public const string Url = "http://localhost:3939";
    public static string AppDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    public static string LibDir = Path.Combine(AppDir, "launcher", "lib");

    [STAThread]
    static void Main()
    {
        // Las DLL de WebView2 viven en launcher\lib para no ensuciar la carpeta principal.
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object s, ResolveEventArgs e)
        {
            string f = Path.Combine(LibDir, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(f) ? Assembly.LoadFrom(f) : null;
        };
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (var mutex = new Mutex(true, "KekeClipper.SingleInstance", out created))
        {
            if (!created) { MessageBox.Show("KekeClipper ya está abierto.", "KekeClipper", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            Application.Run(new MainForm());
        }
    }
}

class MainForm : Form
{
    WebView2 web;
    Label status;
    Process server;
    readonly string dataDir = Path.Combine(Program.AppDir, "data");

    public MainForm()
    {
        Text = "KekeClipper";
        Width = 1360; Height = 900;
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(14, 14, 18);
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

        status = new Label
        {
            Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(236, 236, 241), Font = new Font("Segoe UI", 14f),
            Text = "Abriendo KekeClipper…"
        };
        Controls.Add(status);
        Shown += async delegate { await Start(); };
        FormClosing += delegate { StopServer(); };
    }

    void Say(string msg) { if (InvokeRequired) BeginInvoke(new Action(() => status.Text = msg)); else status.Text = msg; }

    static bool Ping()
    {
        try
        {
            // 127.0.0.1 y no "localhost": el servidor escucha solo en IPv4
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3939/api/ping");
            req.Timeout = 4000; req.Proxy = null;
            using (var r = (HttpWebResponse)req.GetResponse()) return r.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static string FindOnPath(string exe)
    {
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
        foreach (var d in dirs)
        {
            try { var f = Path.Combine(d.Trim(), exe); if (File.Exists(f)) return f; } catch { }
        }
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var c = Path.Combine(pf, "nodejs", exe);
        if (File.Exists(c)) return c;
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        c = Path.Combine(local, "Programs", "nodejs", exe);
        return File.Exists(c) ? c : null;
    }

    int RunAndWait(string file, string args, string label)
    {
        Say(label);
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = Program.AppDir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var p = Process.Start(psi))
        {
            p.OutputDataReceived += delegate { }; p.ErrorDataReceived += delegate { };
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    async Task Start()
    {
        string node = null, npm = null;
        await Task.Run(() =>
        {
            if (Ping()) return; // ya hay un servidor corriendo: solo abrimos la ventana
            node = FindOnPath("node.exe");
            npm = FindOnPath("npm.cmd");
        });

        if (!Ping())
        {
            if (node == null)
            {
                var r = MessageBox.Show(this,
                    "Para funcionar, KekeClipper necesita Node.js (gratis).\n\n¿Lo instalo ahora? (usa winget de Windows y puede pedir permiso)",
                    "Falta Node.js", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes) { Close(); return; }
                int code = await Task.Run(() => RunAndWait("winget", "install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements", "Instalando Node.js… (puede tardar unos minutos)"));
                node = FindOnPath("node.exe"); npm = FindOnPath("npm.cmd");
                if (node == null) { MessageBox.Show(this, "No pude instalar Node.js (código " + code + ").\nInstalalo desde nodejs.org y volvé a abrir la app.", "KekeClipper"); Close(); return; }
            }
            if (!Directory.Exists(Path.Combine(Program.AppDir, "node_modules")))
            {
                if (npm == null) npm = Path.Combine(Path.GetDirectoryName(node), "npm.cmd");
                int code = await Task.Run(() => RunAndWait("cmd.exe", "/c \"\"" + npm + "\" install --omit=dev --no-audit --no-fund\"", "Preparando la app por primera vez… (descarga componentes, 1-2 min)"));
                if (code != 0) { MessageBox.Show(this, "No pude preparar los componentes (npm install falló, código " + code + ").\n¿Hay conexión a internet?", "KekeClipper"); Close(); return; }
            }
            Directory.CreateDirectory(dataDir);
            Say("Arrancando…");
            StartServer(node);
            bool up = await Task.Run(() =>
            {
                for (int i = 0; i < 120; i++) { if (Ping()) return true; if (server != null && server.HasExited) return false; Thread.Sleep(250); }
                return false;
            });
            if (!up)
            {
                MessageBox.Show(this, "La app no pudo arrancar. Mirá el detalle en:\n" + Path.Combine(dataDir, "app.log"), "KekeClipper", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close(); return;
            }
        }
        await OpenWindow();
    }

    void StartServer(string node)
    {
        var log = Path.Combine(dataDir, "app.log");
        var psi = new ProcessStartInfo(node, "server.js")
        {
            WorkingDirectory = Program.AppDir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        psi.EnvironmentVariables["NO_OPEN"] = "1";
        psi.EnvironmentVariables["APP_MODE"] = "1";
        server = Process.Start(psi);
        var w = new StreamWriter(log, false) { AutoFlush = true };
        DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (w) w.WriteLine(e.Data); };
        server.OutputDataReceived += h; server.ErrorDataReceived += h;
        server.BeginOutputReadLine(); server.BeginErrorReadLine();
    }

    void StopServer()
    {
        try { if (server != null && !server.HasExited) { server.Kill(); server.WaitForExit(3000); } } catch { }
    }

    async Task OpenWindow()
    {
        try
        {
            CoreWebView2Environment.SetLoaderDllFolderPath(Program.LibDir);
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KekeClipper", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(14, 14, 18) };
            Controls.Add(web);
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            // Ventanas nuevas (subir a YouTube/Instagram/TikTok, twitch.tv/activate): en tu navegador de siempre,
            // donde ya tenés tus sesiones iniciadas.
            core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            core.DocumentTitleChanged += delegate { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "KekeClipper" : core.DocumentTitle; };
            web.Source = new Uri(Program.Url);
            web.BringToFront();
            status.Visible = false;
        }
        catch (Exception ex)
        {
            var r = MessageBox.Show(this,
                "No pude abrir la ventana de la app (falta el componente WebView2 de Windows).\n\n" + ex.Message + "\n\n¿La abro en tu navegador?",
                "KekeClipper", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes) { OpenExternal(Program.Url); WindowState = FormWindowState.Minimized; Say("KekeClipper está abierto en tu navegador. Cerrá esta ventana para salir."); }
            else Close();
        }
    }

    static void OpenExternal(string url)
    {
        if (string.IsNullOrEmpty(url) || !(url.StartsWith("http://") || url.StartsWith("https://"))) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}
