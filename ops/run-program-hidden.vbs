Option Explicit
' Start a console program without a window, wait for it and return its exit code,
' so Task Scheduler still sees failures (restart-on-failure) and running state.
' Usage: wscript.exe run-program-hidden.vbs <workDir> <program> [args...]

Dim shell, command, i

If WScript.Arguments.Count < 2 Then
    WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
If Len(WScript.Arguments(0)) > 0 Then
    shell.CurrentDirectory = WScript.Arguments(0)
End If

command = Quote(WScript.Arguments(1))
For i = 2 To WScript.Arguments.Count - 1
    command = command & " " & QuoteIfNeeded(WScript.Arguments(i))
Next

WScript.Quit shell.Run(command, 0, True)

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Function QuoteIfNeeded(value)
    If InStr(value, " ") > 0 Or Len(value) = 0 Then
        QuoteIfNeeded = Quote(value)
    Else
        QuoteIfNeeded = value
    End If
End Function
