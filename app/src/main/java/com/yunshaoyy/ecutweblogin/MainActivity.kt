package com.yunshaoyy.ecutweblogin

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import android.widget.EditText
import android.widget.LinearLayout

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefsName = "user_prefs"
    private val url = "http://172.21.255.105"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.settings.javaScriptEnabled = true
        webView.webViewClient = WebViewClient()

        showLoginDialog()
    }

    private fun showLoginDialog() {
        val prefs = getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val savedUser = prefs.getString("username", "")
        val savedPass = prefs.getString("password", "")

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = 50
            setPadding(padding, padding, padding, padding)
        }

        val userInput = EditText(this).apply {
            hint = "账号"
            setText(savedUser)
        }
        val passInput = EditText(this).apply {
            hint = "密码"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                    android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(savedPass)
        }

        layout.addView(userInput)
        layout.addView(passInput)

        AlertDialog.Builder(this)
            .setTitle("请输入账号密码")
            .setView(layout)
            .setPositiveButton("确定") { dialog, _ ->
                val user = userInput.text.toString()
                val pass = passInput.text.toString()

                prefs.edit()
                    .putString("username", user)
                    .putString("password", pass)
                    .apply()

                dialog.dismiss()
                loadWeb(user, pass)
            }
            .setCancelable(false)
            .show()
    }

    private fun loadWeb(user: String, pass: String) {
        webView.loadUrl(url)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)

                webView.evaluateJavascript("""
                    (function() {
                        try {
                            var userInput = document.getElementsByName('DDDDD')[0];
                            var passInput = document.getElementsByName('upass')[0];
                            var ispSelect = document.getElementsByName('ISP_select')[0];
                            var loginBtn  = document.getElementsByName('0MKKey')[0];

                            if (userInput) userInput.value = '$user';
                            if (passInput) passInput.value = '$pass';

                            // 中国移动 cmcc
                            if (ispSelect) {
                                ispSelect.value = '@cmcc';
                                ispSelect.dispatchEvent(new Event('change'));
                            }

                            setTimeout(function() {
                                if (loginBtn) loginBtn.click();
                            }, 500); 
                        } 
                        catch(e) {
                            console.log(e);
                        }
                    })();
                """.trimIndent(), null)
            }
        }
    }
}
