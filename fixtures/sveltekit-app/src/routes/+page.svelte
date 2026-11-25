<script lang="ts">
  import * as m from "$lib/paraglide/messages";
  let name = "Colton";
  let count = 2;
</script>

<main>
  <h1>{m.greeting({ name })}</h1>
  <p>{m.items({ count })}</p>
  <input placeholder="Filter projects" />
  <button>Create project</button>
  <p>Total active {count} items</p>
</main>
