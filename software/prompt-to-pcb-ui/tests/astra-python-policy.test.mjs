import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));

// Only stdlib Python, fake providers and synthetic input. Never load the local
// environment, call an API, invoke native tools, or inspect existing run data.
const suite = String.raw`
import builtins
import contextlib
import io
import json
import os
import runpy
import subprocess
import sys
import types
import unittest
import urllib.request
from unittest.mock import patch, Mock

sys.path.insert(0, sys.argv[1])
MESSAGE = ('Astra beta Python inference requires the server-owned shared call budget; '
           'this path is unsupported')
real_import = builtins.__import__

def no_provider_import(name, *args, **kwargs):
    if name.split('.')[0] in ('anthropic', 'digikey'):
        raise AssertionError('unexpected provider/env import: ' + name)
    return real_import(name, *args, **kwargs)

# Importing policy and direct entrypoints must not discover credentials or SDKs.
with patch.dict(os.environ, {'FL_ASTRA_BETA': '1'}, clear=True), \
        patch('builtins.__import__', side_effect=no_provider_import):
    import llm_json
    import ai_design
    import vision_judge

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {}, clear=True))
        for target in ('urllib.request.urlopen', 'subprocess.run',
                       'toolchain.claude_bin'):
            self.stack.enter_context(patch(target, side_effect=AssertionError(target)))
        self.stack.enter_context(patch('builtins.__import__', side_effect=no_provider_import))

    def denied(self, fn):
        with self.assertRaises(llm_json.AstraPythonInferenceUnsupported) as caught:
            fn()
        self.assertEqual(str(caught.exception), MESSAGE)
        self.assertEqual(caught.exception.code, MESSAGE)
        self.assertNotIsInstance(caught.exception, Exception)

    def test_every_direct_entrypoint_blocks_before_side_effects(self):
        calls = {
            'complete_json': lambda: llm_json.complete_json('s', 'u'),
            'load_env': llm_json.load_env,
            'json_openai': lambda: llm_json._openai('s', 'u'),
            'json_anthropic': lambda: llm_json._anthropic('s', 'u'),
            'json_cli': lambda: llm_json._claude_cli('s', 'u'),
            'design_provider': lambda: ai_design.call_claude('p'),
            'design_main': ai_design.main,
            'vision_anthropic': lambda: vision_judge._anthropic('s', 'u', ['missing.png']),
            'vision_cli': lambda: vision_judge._claude_cli('s', 'u', ['missing.png']),
            'vision_main': vision_judge.main,
        }
        policies = [{'FL_ASTRA_BETA': value} for value in
                    ('1', 'true', 'false', '2', '-1', '0.0', ' ', 'garbage')]
        policies += [{'FL_ASTRA_EXECUTION_POLICY': value} for value in
                     ('', '0', '{}', 'null', 'malformed', '{"inferenceAllowed":true}')]
        policies += [{'FL_ASTRA_BETA': '0', 'FL_ASTRA_EXECUTION_POLICY': ''}]
        policies += [{'FL_ASTRA_ROOT': value} for value in ('', '/fake/isolation')]
        policies += [{'FL_ASTRA_BETA': value, 'FL_ASTRA_ROOT': '/fake/isolation'}
                     for value in ('', '0')]
        for env in policies:
            for name, fn in calls.items():
                with self.subTest(env=env, entrypoint=name), \
                        patch.dict(os.environ, env, clear=True), \
                        patch('builtins.open', side_effect=AssertionError('file access')), \
                        patch.object(ai_design, 'heuristic_spec', side_effect=AssertionError('heuristic')), \
                        patch.object(sys, 'stdin', None), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    self.denied(fn)
                    self.assertEqual(output.getvalue(), '')

    def test_complete_json_blocks_before_even_mocked_env_loader(self):
        with patch.dict(os.environ, {'FL_ASTRA_BETA': '1'}), \
                patch.object(llm_json, 'load_env', side_effect=AssertionError('env loader')) as loader:
            self.denied(lambda: llm_json.complete_json('s', 'u'))
            loader.assert_not_called()

    def test_policy_loaded_by_env_is_terminal_even_with_empty_provider_order(self):
        def load():
            os.environ['FL_ASTRA_EXECUTION_POLICY'] = ''
            os.environ['FL_LLM_ORDER'] = ''
        with patch.object(llm_json, 'load_env', side_effect=load):
            self.denied(lambda: llm_json.complete_json('s', 'u'))

    def test_provider_chain_cannot_swallow_late_policy(self):
        def fail_then_restrict(*args):
            os.environ['FL_ASTRA_EXECUTION_POLICY'] = '{}'
            raise RuntimeError('ordinary provider failure')
        with patch.object(llm_json, 'load_env'), \
                patch.object(llm_json, '_anthropic', side_effect=fail_then_restrict):
            self.denied(lambda: llm_json.complete_json('s', 'u'))

    def test_design_does_not_convert_late_policy_to_heuristic_success(self):
        def heuristic(prompt):
            os.environ['FL_ASTRA_BETA'] = '1'
            return dict(ai_design.BASELINE)
        with patch.object(ai_design, 'heuristic_spec', side_effect=heuristic), \
                patch('builtins.open', side_effect=AssertionError('output write')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.denied(ai_design.main)
            self.assertNotIn('using local interpreter', output.getvalue())
            self.assertNotIn('wrote spec', output.getvalue())

    def test_vision_does_not_convert_late_policy_to_unavailable_verdict(self):
        def fail_then_restrict(*args):
            os.environ['FL_ASTRA_BETA'] = '1'
            raise RuntimeError('ordinary provider failure')
        with patch.object(sys, 'stdin', io.StringIO('{"images":["fake.png"]}')), \
                patch.object(os.path, 'exists', return_value=True), \
                patch.object(vision_judge, '_anthropic', side_effect=fail_then_restrict), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.denied(vision_judge.main)
            self.assertEqual(output.getvalue(), '')

    def test_mocked_script_entrypoints_exit_without_input_or_output_files(self):
        for name in ('ai_design.py', 'vision_judge.py'):
            with self.subTest(script=name), \
                    patch.dict(os.environ, {'FL_ASTRA_EXECUTION_POLICY': ''}), \
                    patch.object(sys, 'argv', [name]), \
                    patch.object(sys, 'stdin', None), \
                    patch('builtins.open', side_effect=AssertionError('file access')), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.denied(lambda: runpy.run_path(os.path.join(sys.path[0], name), run_name='__main__'))
                self.assertEqual(output.getvalue(), '')

    def test_nonbeta_provider_order_and_fallback_unchanged(self):
        for env in ({}, {'FL_ASTRA_BETA': ''}, {'FL_ASTRA_BETA': '0'}):
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), \
                    patch.object(llm_json, 'load_env') as loader, \
                    patch.object(llm_json, '_anthropic', side_effect=RuntimeError('offline')) as first, \
                    patch.object(llm_json, '_openai', return_value={'ok': True}) as second, \
                    patch.object(llm_json, '_claude_cli') as third:
                self.assertEqual(llm_json.complete_json('s', 'u'), {'ok': True})
                loader.assert_called_once_with()
                first.assert_called_once_with('s', 'u')
                second.assert_called_once_with('s', 'u')
                third.assert_not_called()

    def test_nonbeta_direct_providers_with_fake_sdk_http_and_cli(self):
        stream = Mock()
        stream.__enter__ = Mock(return_value=stream)
        stream.__exit__ = Mock(return_value=False)
        stream.get_final_message.return_value = types.SimpleNamespace(
            stop_reason='end_turn', content=[types.SimpleNamespace(type='text', text='{"ok":true}')])
        stream.text_stream = ['{"ok":true}']
        client = Mock()
        client.messages.stream.return_value = stream
        sdk = types.SimpleNamespace(Anthropic=Mock(return_value=client))
        def fake_import(name, *args, **kwargs):
            return sdk if name == 'anthropic' else no_provider_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=fake_import):
            self.assertEqual(llm_json._anthropic('s', 'u'), {'ok': True})
            self.assertEqual(vision_judge._anthropic('s', 'u', []), {'ok': True})
        with patch('toolchain.claude_bin', return_value='fake-claude'), \
                patch('subprocess.run', return_value=types.SimpleNamespace(
                    returncode=0, stdout='{"ok":true}', stderr='')) as spawn:
            self.assertEqual(llm_json._claude_cli('s', 'u'), {'ok': True})
            self.assertEqual(vision_judge._claude_cli('s', 'u', []), {'ok': True})
            self.assertEqual(spawn.call_count, 2)
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'fake', 'ANTHROPIC_API_KEY': 'fake'}), \
                patch('urllib.request.urlopen', return_value=io.BytesIO(
                    b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')):
            self.assertEqual(llm_json._openai('s', 'u'), {'ok': True})
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'fake'}), \
                patch('urllib.request.urlopen', return_value=io.BytesIO(
                    b'{"content":[{"text":"{\\"ok\\":true}"}]}')):
            self.assertEqual(ai_design.call_claude('p'), {'ok': True})

    def test_nonbeta_design_still_uses_heuristic_on_ordinary_api_failure(self):
        output_file = io.StringIO()
        with patch.object(ai_design, 'call_claude', side_effect=RuntimeError('offline')), \
                patch('builtins.open', return_value=output_file), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            ai_design.main()
            self.assertIn('using local interpreter', output.getvalue())
            self.assertEqual(json.loads(output_file.getvalue())['probes'], 8)

    def test_nonbeta_vision_still_falls_back_and_reports_unavailable(self):
        for fallback in ({'ok': True}, RuntimeError('offline')):
            cli = Mock(side_effect=fallback) if isinstance(fallback, Exception) else Mock(return_value=fallback)
            with self.subTest(fallback=fallback), \
                    patch.object(sys, 'stdin', io.StringIO('{"images":["fake.png"]}')), \
                    patch.object(os.path, 'exists', return_value=True), \
                    patch.object(vision_judge, '_anthropic', side_effect=RuntimeError('offline')), \
                    patch.object(vision_judge, '_claude_cli', cli), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(vision_judge.main(), 0)
                result = json.loads(output.getvalue())
                self.assertEqual(result['ok'], not isinstance(fallback, Exception))
                cli.assert_called_once_with('', '', ['fake.png'])

unittest.main(argv=['astra-python-policy'], verbosity=2)
`;

test('Python Astra beta inference fails closed before side effects; nonbeta behavior is preserved', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'astra-python-policy-'));
  try {
    const result = spawnSync('python3', ['-I', '-B', '-c', suite, scripts], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Ran 11 tests/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
