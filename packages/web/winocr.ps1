param([Parameter(Mandatory=$true)][string]$ImagePath)

# Set output encoding to UTF-8 so Node.js (execSync with encoding:'utf8') can decode Chinese correctly
# Without this, PowerShell 5.1 defaults to system code page (GBK/CP936) for stdout,
# causing Chinese characters to be misinterpreted as garbled text in Node.js
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Load .NET assemblies for WinRT interop
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Threading.Tasks -ErrorAction SilentlyContinue

# Load WinRT types for OCR
try {
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
} catch {
    Write-Output (ConvertTo-Json -Compress @{ error = "Failed to load WinRT types: " + $_.Exception.Message })
    exit 1
}

# Helper: await a WinRT IAsyncOperation
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitOp($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($op))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

# Check image file exists
if (-not (Test-Path $ImagePath)) {
    Write-Output (ConvertTo-Json -Compress @{ error = "Image file not found: $ImagePath" })
    exit 1
}

try {
    # Open file as random access stream
    $fileStream = [System.IO.File]::OpenRead($ImagePath)
    try {
        $winStream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fileStream)

        # Decode bitmap
        $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($winStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = AwaitOp $decoder.GetSoftwareBitmapAsync() ([Windows.Graphics.Imaging.SoftwareBitmap])

        # Create OCR engine (try user profile languages first, then zh-Hans, then en-US)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $engine) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('zh-Hans-CN')
        }
        if (-not $engine) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('zh')
        }
        if (-not $engine) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('en-US')
        }
        if (-not $engine) {
            Write-Output (ConvertTo-Json -Compress @{ error = "No OCR engine available" })
            exit 1
        }

        # Recognize text
        $result = AwaitOp $engine.RecognizeAsync($bitmap) ([Windows.Media.Ocr.OcrResult])

        # Build words array
        $words = @()
        foreach ($line in $result.Lines) {
            foreach ($word in $line.Words) {
                $words += @{
                    text = $word.Text
                    x = [int]$word.BoundingRect.X
                    y = [int]$word.BoundingRect.Y
                    w = [int]$word.BoundingRect.Width
                    h = [int]$word.BoundingRect.Height
                }
            }
        }

        $output = @{
            text = $result.Text
            words = $words
            lang = $engine.RecognizerLanguage.LanguageTag
        }

        Write-Output (ConvertTo-Json -Compress -Depth 5 $output)
    } finally {
        $fileStream.Close()
    }
} catch {
    Write-Output (ConvertTo-Json -Compress @{ error = "OCR failed: " + $_.Exception.Message })
    exit 1
}
