public class LinkedListTester {
	public static void main(String [] args) {
		LinkedList<Integer> list = new LinkedList<Integer>(1);
		list.add(3);
		list.add(2342);
		list.add(53462456);
		list.add(4);

		System.out.println(list.toString());

		list.remove(2342);

		System.out.println(list.toString());
		
	}
}