package com.yunshaoyy.ecutweblogin

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.text.InputType
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "ECUTLogin"
        const val PREFS_NAME = "user_prefs"
        const val LOGIN_URL = "http://172.21.255.105"
        const val MAX_LOG_LINES = 400
    }

    private lateinit var webView: WebView
    private lateinit var debugPanel: View
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private val handler = Handler(Looper.getMainLooper())
    private val logLines = ArrayList<String>()
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    private var autofillJs = ""
    private var dumpJs = ""

    private var username = ""
    private var password = ""
    private var ispSuffix = ""
    private var autoSubmit = true

    private var injectSucceededFor: String? = null
    private val pendingInject = Runnable { doInject("delayed") }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        debugPanel = findViewById(R.id.debugPanel)
        logView = findViewById(R.id.logView)
        logScroll = findViewById(R.id.logScroll)

        autofillJs = readAsset("autofill.js")
        dumpJs = readAsset("dump.js")

        setupButtons()
        setupWebView()
        restorePrefs()

        // 返回键退出时彻底结束进程，避免 WebView / 网络连接残留在后台
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                exitApp()
            }
        })

        val restored = savedInstanceState?.let {
            username = it.getString("username", username) ?: username
            password = it.getString("password", password) ?: password
            ispSuffix = it.getString("isp", ispSuffix) ?: ispSuffix
            autoSubmit = it.getBoolean("autoSubmit", autoSubmit)
            webView.restoreState(it)
            true
        } ?: false

        if (!restored) {
            showLoginDialog()
        } else {
            appendLog("已恢复上次会话")
            scheduleInject(webView.url ?: LOGIN_URL)
        }
    }

    private fun readAsset(name: String): String = try {
        assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() }.removePrefix("\uFEFF")
    } catch (e: Exception) {
        Log.e(TAG, "读取 assets/$name 失败", e)
        ""
    }

    private fun setupButtons() {
        findViewById<Button>(R.id.btnDebug).setOnClickListener {
            debugPanel.visibility = if (debugPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        findViewById<Button>(R.id.btnRetry).setOnClickListener {
            injectSucceededFor = null
            doInject("manual")
        }
        findViewById<Button>(R.id.btnDump).setOnClickListener { runDump() }
        findViewById<Button>(R.id.btnClearLog).setOnClickListener {
            logLines.clear()
            logView.text = ""
        }
        findViewById<Button>(R.id.btnClose).setOnClickListener { debugPanel.visibility = View.GONE }
        findViewById<Button>(R.id.btnReload).setOnClickListener {
            injectSucceededFor = null
            webView.loadUrl(LOGIN_URL)
        }
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = (userAgentString ?: "") + " ECUTAutoLogin/2.0"
        }
        webView.setBackgroundColor(Color.WHITE)
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.addJavascriptInterface(JsBridge(), "NativeApp")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage?): Boolean {
                cm?.let {
                    val msg = it.message() ?: return@let
                    // 注入脚本自己的日志走 JsBridge，避免重复
                    if (!msg.startsWith("[ECUT]")) {
                        appendLog("[console:${it.messageLevel()}] $msg")
                    }
                }
                return true
            }

            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress == 100) scheduleInject(view?.url ?: LOGIN_URL)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                // 真正发生了导航：允许对新页面重新注入（登录失败刷新后也能重填）
                injectSucceededFor = null
                appendLog("开始加载: $url")
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                appendLog("加载完成: $url")
                scheduleInject(url ?: LOGIN_URL)
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                // SPA / hash 跳转不会触发 onPageFinished
                scheduleInject(url ?: LOGIN_URL)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return false
                return !(u.startsWith("http://") || u.startsWith("https://"))
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    appendLog("页面加载失败: ${error?.description}")
                }
            }

            override fun onReceivedSslError(view: WebView?, h: SslErrorHandler?, error: SslError?) {
                appendLog("SSL 证书错误: ${error?.url}")
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("证书不受信任")
                    .setMessage("认证页证书校验失败，是否继续？\n${error?.url}")
                    .setPositiveButton("继续") { _, _ -> h?.proceed() }
                    .setNegativeButton("取消") { _, _ -> h?.cancel() }
                    .setCancelable(false)
                    .show()
            }
        }
    }

    /* ---------------- 注入 ---------------- */

    private fun scheduleInject(url: String) {
        Log.v(TAG, "scheduleInject: " + url)
        handler.removeCallbacks(pendingInject)
        handler.postDelayed(pendingInject, 250)
    }

    private fun doInject(reason: String) {
        if (autofillJs.isEmpty()) {
            appendLog("autofill.js 未加载，无法注入")
            return
        }
        if (username.isBlank() || password.isEmpty()) {
            appendLog("账号或密码为空，跳过注入")
            return
        }
        val current = webView.url ?: LOGIN_URL
        if (injectSucceededFor == current && reason != "manual") {
            appendLog("本页已填充成功，跳过重复注入 ($current)")
            return
        }
        val cfg = JSONObject()
            .put("user", username)
            .put("pass", password)
            .put("ispSuffix", ispSuffix)
            .put("autoSubmit", autoSubmit)
            .put("debug", true)
            .put("pageUrl", current)
            .put("reason", reason)

        val js = autofillJs.replace("__ECUT_CONFIG__", JSONObject.quote(cfg.toString()))
        appendLog("注入脚本 ($reason) -> $current")
        webView.evaluateJavascript(js) { result ->
            runOnUiThread { appendLog("注入返回: ${result?.take(400)}") }
        }
    }

    private fun runDump() {
        if (dumpJs.isEmpty()) {
            appendLog("dump.js 未加载")
            return
        }
        appendLog("开始收集页面诊断信息…")
        webView.evaluateJavascript(dumpJs) { result ->
            runOnUiThread {
                val text = result?.trim()?.removeSurrounding("\"")
                    ?.replace("\\\"", "\"")?.replace("\\\\", "\\")
                    ?.replace("\\n", "\n")?.replace("\\/", "/")
                    ?: "null"
                appendLog("=== 页面诊断 ===")
                prettyPrint(text).forEach { appendLog(it) }
                appendLog("=== 诊断结束 ===")
                debugPanel.visibility = View.VISIBLE
            }
        }
    }

    private fun prettyPrint(json: String): List<String> {
        return try {
            val obj = JSONObject(json)
            obj.toString(2).lines().take(600)
        } catch (e: Exception) {
            json.chunked(200).take(200)
        }
    }

    /* ---------------- 日志 ---------------- */

    private fun appendLog(msg: String) {
        val line = "${timeFmt.format(Date())} $msg"
        Log.d(TAG, msg)
        logLines.add(line)
        while (logLines.size > MAX_LOG_LINES) logLines.removeAt(0)
        logView.text = logLines.joinToString("\n")
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    /* ---------------- JS -> 原生 ---------------- */

    private inner class JsBridge {
        @JavascriptInterface
        fun onLog(level: String?, msg: String?) {
            handler.post { appendLog("[JS/${level ?: "?"}] ${msg ?: ""}") }
        }

        @JavascriptInterface
        fun onResult(json: String?) {
            handler.post {
                appendLog("[JS/result] $json")
                try {
                    val o = JSONObject(json ?: "{}")
                    if (o.optString("step") == "fill" && o.optBoolean("ok")) {
                        injectSucceededFor = webView.url
                        toast("账号密码已填入")
                    }
                    if (o.optString("step") == "done") {
                        debugPanel.visibility = View.VISIBLE
                    }
                } catch (_: Exception) {
                }
            }
        }
    }

    /* ---------------- 登录弹窗 ---------------- */

    private fun restorePrefs() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        username = prefs.getString("username", "") ?: ""
        password = prefs.getString("password", "") ?: ""
        ispSuffix = prefs.getString("isp", "") ?: ""
        autoSubmit = prefs.getBoolean("autoSubmit", true)
        if (prefs.getBoolean("debugPanel", true)) debugPanel.visibility = View.VISIBLE
    }

    private fun showLoginDialog() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val pad = (16 * resources.displayMetrics.density).toInt()

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad * 2, pad, pad * 2, 0)
        }

        val userInput = EditText(this).apply {
            hint = "账号 / 学号"
            setText(username)
            isSingleLine = true
        }
        val passInput = EditText(this).apply {
            hint = "密码"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(password)
            isSingleLine = true
        }
        val ispInput = EditText(this).apply {
            hint = "运营商后缀（选填，如 @cmcc）"
            setText(ispSuffix)
            isSingleLine = true
        }
        val autoCheck = CheckBox(this).apply {
            text = "填好后自动点击登录"
            isChecked = autoSubmit
        }
        val debugCheck = CheckBox(this).apply {
            text = "显示调试日志面板"
            isChecked = debugPanel.visibility == View.VISIBLE
        }

        layout.addView(userInput)
        layout.addView(passInput)
        layout.addView(ispInput)
        layout.addView(autoCheck)
        layout.addView(debugCheck)

        AlertDialog.Builder(this)
            .setTitle("校园网登录")
            .setView(layout)
            .setPositiveButton("登录") { _, _ ->
                username = userInput.text.toString().trim()
                password = passInput.text.toString()
                ispSuffix = ispInput.text.toString().trim()
                autoSubmit = autoCheck.isChecked
                debugPanel.visibility = if (debugCheck.isChecked) View.VISIBLE else View.GONE

                prefs.edit()
                    .putString("username", username)
                    .putString("password", password)
                    .putString("isp", ispSuffix)
                    .putBoolean("autoSubmit", autoSubmit)
                    .putBoolean("debugPanel", debugCheck.isChecked)
                    .apply()

                if (username.isBlank() || password.isEmpty()) {
                    toast("账号或密码为空")
                    return@setPositiveButton
                }
                injectSucceededFor = null
                appendLog("开始加载认证页，账号=$username 后缀=${ispSuffix.ifEmpty { "(无)" }}")
                webView.loadUrl(LOGIN_URL)
            }
            .setCancelable(false)
            .show()
    }

    /* ---------------- 生命周期 ---------------- */

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("username", username)
        outState.putString("password", password)
        outState.putString("isp", ispSuffix)
        outState.putBoolean("autoSubmit", autoSubmit)
        webView.saveState(outState)
    }

    private var webViewDestroyed = false

    private fun destroyWebView() {
        if (webViewDestroyed) return
        webViewDestroyed = true
        try {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.removeAllViews()
            webView.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "销毁 WebView 失败", e)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        destroyWebView()
        super.onDestroy()
    }

    /** 返回键退出：清理 WebView 后直接杀掉本进程。 */
    private fun exitApp() {
        handler.removeCallbacksAndMessages(null)
        destroyWebView()
        finishAffinity()
        Log.i(TAG, "back pressed -> kill process")
        Process.killProcess(Process.myPid())
    }
}
