using System;

class Program
{
    static void Main()
    {
        string name1 = Console.ReadLine();
        string name2 = Console.ReadLine();
        int middle = name1.Length / 2;
        Console.WriteLine(name1.Substring(0, middle) + name2 + name1.Substring(middle));
    }
}