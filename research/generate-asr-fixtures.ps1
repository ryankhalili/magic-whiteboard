# Synthetic speech only: reproducible smoke coverage, not an accuracy benchmark.
param([string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) '.local/asr-fixtures'))
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$cases = @(
  @{ name = 'integral'; text = 'The integral from pi to two pi of sine of x d x.' },
  @{ name = 'evaluation'; text = 'This now equals negative cosine of x bar from pi to two pi.' },
  @{ name = 'vertical-line'; text = 'Plot x equals one.' },
  @{ name = 'parabola-window'; text = 'Set the x axis from negative ten to ten and fit the whole parabola.' },
  @{ name = 'textbook-reference'; text = 'Find theorem four point two in the textbook and place it here.' },
  @{ name = 'surface'; text = 'Plot z equals x squared plus y squared in three dimensions.' },
  @{ name = 'physics'; text = 'The divergence of the electric field equals rho over epsilon naught.' },
  @{ name = 'plain-text'; text = 'Photosynthesis converts light energy into chemical energy.' }
)
try {
  foreach ($case in $cases) {
    $synth.SetOutputToWaveFile((Join-Path $OutputDirectory ($case.name + '.wav')), $format)
    $synth.Speak($case.text)
    $synth.SetOutputToNull()
  }
  $cases | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'expected.json') -Encoding utf8
} finally { $synth.Dispose() }
Write-Output "Created $($cases.Count) synthetic speech fixtures."
